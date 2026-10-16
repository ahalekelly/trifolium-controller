#include "adcSampler.h"
#include <hardware/adc.h>
#include <hardware/clocks.h>
#include <hardware/dma.h>
#include "logging.h"
#include "types.h" // PIN_NOT_USED

namespace
{
constexpr uint32_t kRatePerPin_hz = 100000;
constexpr uint8_t kPinCount = 4;            // GPIO 26-29, ADC inputs 0-3
constexpr uint32_t kSamplesPerPin = 512;    // ~5 ms, so a late tick still finds its samples

// The data channel fills it from the start, a whole number of rounds of the round robin at a time,
// so where a sample lands says which pin it came from.
volatile uint16_t samples[kPinCount * kSamplesPerPin];
// What the control channel copies into the data channel's write address. In RAM, not flash: the DMA
// reads it while a flash write has the XIP cache off.
volatile uint16_t* samplesStart = samples;

uint8_t inputs[kPinCount]; // the ADC inputs in use, ascending, the order the round robin takes
uint8_t inputCount = 0;
uint32_t length = 0; // samples per lap of the buffer
uint32_t readAt = 0;
int dataChannel;
uint32_t millivolts_[kPinCount];
} // namespace

void AdcSampler::begin(std::initializer_list<uint8_t> pins)
{
    uint32_t mask = 0;
    for (uint8_t pin : pins)
    {
        if (pin == PIN_NOT_USED)
            continue;
        if (pin < ADC_BASE_PIN || pin >= ADC_BASE_PIN + kPinCount)
            panic("AdcSampler: GPIO %d has no ADC input", pin);
        mask |= 1u << (pin - ADC_BASE_PIN);
    }
    if (!mask)
        return;

    adc_init();
    for (uint8_t input = 0; input < kPinCount; input++)
    {
        if (mask & (1u << input))
        {
            adc_gpio_init(ADC_BASE_PIN + input);
            inputs[inputCount++] = input;
        }
    }
    length = inputCount * kSamplesPerPin;
    adc_select_input(inputs[0]); // the round robin starts on the selected input
    adc_set_round_robin(mask);
    adc_set_clkdiv((float)clock_get_hz(clk_adc) / (kRatePerPin_hz * inputCount) - 1);
    // Bit 15 of each sample flags a failed conversion, which update() leaves out.
    adc_fifo_setup(true, true, 1, true, false);

    dataChannel = dma_claim_unused_channel(true);
    const int controlChannel = dma_claim_unused_channel(true);

    dma_channel_config_t data = dma_channel_get_default_config(dataChannel);
    channel_config_set_transfer_data_size(&data, DMA_SIZE_16);
    channel_config_set_read_increment(&data, false);
    channel_config_set_write_increment(&data, true);
    channel_config_set_dreq(&data, DREQ_ADC);
    channel_config_set_chain_to(&data, controlChannel);
    dma_channel_configure(dataChannel, &data, samples, &adc_hw->fifo, length, false);

    // At the end of each lap, points the data channel back at the start of the buffer, which also
    // restarts it, so the stream never runs out.
    dma_channel_config_t control = dma_channel_get_default_config(controlChannel);
    channel_config_set_read_increment(&control, false);
    dma_channel_configure(controlChannel, &control,
                          &dma_channel_hw_addr(dataChannel)->al2_write_addr_trig, &samplesStart, 1,
                          false);

    dma_channel_start(dataChannel);
    adc_run(true);
    delay(1);
    update();
}

void AdcSampler::update()
{
    if (!inputCount)
        return;
    // The FIFO holds 8 samples and the DMA takes each as it lands, so only something else stopping
    // the DMA can lose one - and a lost sample moves every later one onto the next pin.
    if (adc_hw->fcs & ADC_FCS_OVER_BITS)
    {
        logger.error("ADC FIFO overflowed, its samples no longer match their pins - rebooting");
        delay(100);
        rp2040.reboot();
    }

    // Up to the last whole round, so that each block starts on inputs[0]. Counted from TRANS_COUNT,
    // as RP2040-E12 advises, rather than read from WRITE_ADDR. A sample still in flight reads as the
    // same pin's from a lap before.
    uint32_t writeAt = (length - dma_channel_hw_addr(dataChannel)->transfer_count) % length;
    writeAt -= writeAt % inputCount;
    uint32_t rounds = 0;
    uint32_t sum[kPinCount] = {};
    uint32_t failed[kPinCount] = {};
    while (readAt != writeAt)
    {
        for (uint8_t i = 0; i < inputCount; i++)
        {
            const uint16_t sample = samples[readAt + i];
            if (sample & ADC_FIFO_ERR_BITS)
                failed[i]++;
            else
                sum[i] += sample;
        }
        rounds++;
        readAt += inputCount;
        if (readAt == length)
            readAt = 0;
    }
    for (uint8_t i = 0; i < inputCount; i++)
    {
        const uint32_t count = rounds - failed[i];
        if (count)
            millivolts_[inputs[i]] = (uint64_t)sum[i] * 3300 / (count * 4095);
    }
}

uint32_t AdcSampler::millivolts(uint8_t pin)
{
    return millivolts_[pin - ADC_BASE_PIN];
}
