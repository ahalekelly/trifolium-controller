#include "batteryMonitor.h"
#include "adcSampler.h"
#include "types.h" // PIN_NOT_USED
#include "logging.h"

BatteryMonitor::BatteryMonitor(uint8_t adcPin, float calibrationFactor, uint8_t cellCount)
    : adcPin_(adcPin), calibrationFactor_(calibrationFactor), cellCount_(cellCount)
{
}

void BatteryMonitor::begin()
{
    if (adcPin_ != PIN_NOT_USED)
    {
        isDefined_ = true;
        update();
        logger.info("Battery voltage (before calibration): ", adc_mv_ * 11);
        if (calibrationFactor_ != 1.0)
        {
            logger.info("Battery voltage (after calibration): ", calibrationFactor_ * adc_mv_ * 11);
        }
    }
    else
    {
        isDefined_ = false;
        voltage_mv_ = cellCount_ * 3500;
    }
}

void BatteryMonitor::update()
{
    if (!isDefined_)
        return;

    adc_mv_ = AdcSampler::millivolts(adcPin_);
    voltage_mv_ = calibrationFactor_ * adc_mv_ * 11;
}
