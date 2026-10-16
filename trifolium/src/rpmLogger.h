#pragma once
#include <Arduino.h>
#include <new> // std::nothrow - startCapture() must not treat allocation failure as fatal
#include "adcSampler.h"
#include "flywheelMotor.h"
#include "logging.h"
#include "types.h" // PIN_NOT_USED

class RpmLogger
{
  public:
    ~RpmLogger() { freeBuffers(); }

    // Returns false if the allocation failed - caller should just skip logging that rev cycle.
    // currentAdcPin is the ESC's current-sense output, or PIN_NOT_USED to leave its column out.
    bool startCapture(uint32_t length, uint8_t currentAdcPin)
    {
        freeBuffers();
        targetRpmCache_ = new (std::nothrow) uint32_t[length][4];
        rpmCache_ = new (std::nothrow) uint32_t[length][4];
        throttleCache_ = new (std::nothrow) int16_t[length][4];
        valueCache_ = new (std::nothrow) float[length][4];
        voltageCache_ = new (std::nothrow) int32_t[length]; // per sample, not per motor
        if (currentAdcPin != PIN_NOT_USED)
            currentCache_ = new (std::nothrow) int16_t[length]; // the 4-in-1's total, not per motor
        if (!targetRpmCache_ || !rpmCache_ || !throttleCache_ || !valueCache_ || !voltageCache_ ||
            (currentAdcPin != PIN_NOT_USED && !currentCache_))
        {
            freeBuffers();
            return false;
        }
        currentAdcPin_ = currentAdcPin;
        length_ = length;
        cacheIndex_ = 0;
        readyMs_ = -1;
        slowestMotor_ = -1;
        timedOut_ = false;
        return true;
    }

    // Each spin-up tick of the capture: whether the firmware's fire-ready test passes, and the
    // motor furthest short of firing speed. The last one short before it passes is the slowest.
    void noteSpinup(bool ready, int8_t lagging, uint32_t sinceRevStart_ms)
    {
        if (!recordingSpinup())
            return;
        if (ready)
            readyMs_ = (int32_t)sinceRevStart_ms;
        else if (lagging >= 0)
            slowestMotor_ = lagging;
    }

    // The rampup timeout ended the rev before it was fire-ready.
    void noteTimeout()
    {
        if (recordingSpinup())
            timedOut_ = true;
    }

    // Call once per control-loop tick to record the current sample, if a capture is active. Each
    // tick gets its own row.
    void record(FlywheelMotor motorArr[4], const bool motors[4], int32_t batteryVoltage_mv)
    {
        if (!armed() || cacheIndex_ >= length_)
            return;
        voltageCache_[cacheIndex_] = batteryVoltage_mv;
        // The pin's own voltage, unscaled: amps per volt and the zero offset vary by ESC.
        if (currentCache_)
            currentCache_[cacheIndex_] = AdcSampler::millivolts(currentAdcPin_);
        for (int i = 0; i < 4; i++)
        {
            if (motors[i])
            {
                rpmCache_[cacheIndex_][i] = motorArr[i].motorRPM;
                targetRpmCache_[cacheIndex_][i] = motorArr[i].targetRPM; // mostly for reference
                throttleCache_[cacheIndex_][i] = (int16_t)(motorArr[i].PIDOutput);
                valueCache_[cacheIndex_][i] = motorArr[i].PIDIntegral;
            }
        }
        cacheIndex_++;
    }

    bool dumpIfReady(const bool motors[4])
    {
        if (!armed() || cacheIndex_ < length_)
            return false;

        char rowBuf[240];
        int len = snprintf(rowBuf, sizeof(rowBuf), "%s",
                           currentCache_ ? "Voltage_mv,Current_mv," : "Voltage_mv,");
        for (int j = 0; j < 4; j++)
        {
            if (motors[j])
                len += snprintf(rowBuf + len, sizeof(rowBuf) - len,
                                "Motor %d,TargetRPM %d,Throttle %d,value %d,", j, j, j, j);
        }
        Serial.println(rowBuf);

        for (uint32_t i = 0; i < length_; i++)
        {
            len = snprintf(rowBuf, sizeof(rowBuf), "%ld,", (long)voltageCache_[i]);
            if (currentCache_)
                len += snprintf(rowBuf + len, sizeof(rowBuf) - len, "%d,", currentCache_[i]);
            for (int j = 0; j < 4; j++)
            {
                if (motors[j])
                {
                    char valueStr[10];
                    dtostrf(valueCache_[i][j], 1, 2, valueStr);
                    len += snprintf(rowBuf + len, sizeof(rowBuf) - len, "%lu,%lu,%d,%s,",
                                    (unsigned long)rpmCache_[i][j],
                                    (unsigned long)targetRpmCache_[i][j], throttleCache_[i][j],
                                    valueStr);
                }
            }
            Serial.println(rowBuf);
        }
        // After the rows, so a host has the whole capture by the time it reads this. readyMs is
        // null when the rev ended, or the capture did, before the wheels were at speed.
        Serial.print("{\"evt\":\"rpmCapture\",\"readyMs\":");
        if (readyMs_ < 0)
            Serial.print("null");
        else
            Serial.print(readyMs_);
        Serial.print(",\"slowestMotor\":");
        if (slowestMotor_ < 0)
            Serial.print("null");
        else
            Serial.print(slowestMotor_);
        Serial.println(timedOut_ ? ",\"timedOut\":true}" : ",\"timedOut\":false}");
        freeBuffers(); // capture complete - release the buffer
        return true;
    }

    bool armed() const { return targetRpmCache_ != nullptr; }

  private:
    // Still recording, and neither fire-ready nor timed out yet: only the first outcome counts.
    bool recordingSpinup() const
    {
        return armed() && cacheIndex_ < length_ && readyMs_ < 0 && !timedOut_;
    }

    void freeBuffers()
    {
        delete[] targetRpmCache_;
        delete[] rpmCache_;
        delete[] throttleCache_;
        delete[] valueCache_;
        delete[] voltageCache_;
        delete[] currentCache_;
        targetRpmCache_ = nullptr;
        rpmCache_ = nullptr;
        throttleCache_ = nullptr;
        valueCache_ = nullptr;
        voltageCache_ = nullptr;
        currentCache_ = nullptr;
        length_ = 0;
        cacheIndex_ = 0;
    }

    uint32_t (*targetRpmCache_)[4] = nullptr;
    uint32_t (*rpmCache_)[4] = nullptr;
    int16_t (*throttleCache_)[4] = nullptr;
    float (*valueCache_)[4] = nullptr;
    int32_t* voltageCache_ = nullptr;
    int16_t* currentCache_ = nullptr; // null when no currentAdcPin is set
    uint8_t currentAdcPin_ = PIN_NOT_USED;
    uint32_t length_ = 0;
    uint32_t cacheIndex_ = 0;
    int32_t readyMs_ = -1;
    int8_t slowestMotor_ = -1;
    bool timedOut_ = false;
};
