#pragma once
#include <Arduino.h>

// Core 0 owns it (begin()/update() only ever called from core 0); core 1 only calls the
// read-only getters below, and updateCalibration() from the menu
class BatteryMonitor
{
  public:
    BatteryMonitor(uint8_t adcPin, float calibrationFactor, uint8_t cellCount);

    void begin();  // one-shot boot-time read - call once from setup(), after AdcSampler::begin()
    void update(); // per-tick read - call every ~1ms, after AdcSampler::update()

    // Applies from the next update(). One word, so core 1 can write it while core 0 reads.
    void updateCalibration(float calibrationFactor) { calibrationFactor_ = calibrationFactor; }

    bool isDefined() const { return isDefined_; }
    int32_t getVoltage_mv() const { return voltage_mv_; }

  private:
    uint8_t adcPin_;
    float calibrationFactor_;
    uint8_t cellCount_;
    bool isDefined_ = false;
    uint32_t adc_mv_ = 0;
    int32_t voltage_mv_ = 0;
};
