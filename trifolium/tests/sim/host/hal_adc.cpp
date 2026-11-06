// The firmware's AdcSampler on the fake board, in place of src/adcSampler.cpp and its DMA: each
// reading is the pin's analogRead() at that moment, in mV.

#include <Arduino.h>

#include "adcSampler.h"
#include "types.h" // PIN_NOT_USED

void AdcSampler::begin(std::initializer_list<uint8_t> pins)
{
    for (uint8_t pin : pins)
    {
        if (pin != PIN_NOT_USED)
            analogRead(pin); // hands the pin to the ADC, as adc_gpio_init() does
    }
}

void AdcSampler::update() {}

uint32_t AdcSampler::millivolts(uint8_t pin)
{
    return analogRead(pin) * 3300UL / 1023;
}
