#pragma once
#include <Arduino.h>
#include <initializer_list>

// The ADC runs free in round robin over every analog pin in use, about 100 kHz each, and DMA streams
// the samples to RAM. update() averages each pin's samples since its last call, so called once a tick
// it gives one block average per pin per tick, with the ESCs' PWM ripple averaged out.
//
// The ADC is this module's alone: an analogRead() would move the round robin and leave every later
// sample filed under the wrong pin. Core 0 only.
namespace AdcSampler
{
// Starts sampling, then takes the first block. Each pin is 26-29 or PIN_NOT_USED. Once, from setup().
void begin(std::initializer_list<uint8_t> pins);

// Averages each pin's samples since the last call. Once a control tick.
void update();

// A pin begin() was given, averaged over the block update() last took, in mV at the pin.
uint32_t millivolts(uint8_t pin);
} // namespace AdcSampler
