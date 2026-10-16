#pragma once

#include <Arduino.h>
#include "../lib/Bounce2/src/Bounce2.h"

bool menuIsOpen();

// The rev and trigger switches, which the console's Rev and Fire buttons can also hold (HOLD and
// RELEASE in serialCommands.cpp). A console hold reads as the switch pressed at the pin, so
// debouncing, edges and every rule downstream - fire mode, SAFE, the rev safety latch - treat it
// exactly as the physical switch. A board without the pin gets the switch this way too.
//
// The console resends HOLD while its button is down. A hold not renewed within
// CONSOLE_HOLD_TIMEOUT_MS lapses, so a dropped link or closed tab lets go of the switch. The open
// menu ignores a hold, since it reads these switches for navigation.
class ConsoleSwitch : public Bounce2::Button
{
  public:
    static const uint32_t CONSOLE_HOLD_TIMEOUT_MS = 300;

    void attach(int pin, int mode)
    {
        wired_ = true;
        Bounce2::Button::attach(pin, mode);
    }

    // Written on core 1, read on core 0: the time first, so a fresh hold never reads as lapsed.
    void holdFromConsole()
    {
        heldAt_ms_ = millis();
        held_ = true;
    }
    void releaseFromConsole() { held_ = false; }

  protected:
    bool readCurrentState() override
    {
        if (held_ && millis() - heldAt_ms_ < CONSOLE_HOLD_TIMEOUT_MS && !menuIsOpen())
            return getPressedState();
        return wired_ ? Bounce2::Button::readCurrentState() : !getPressedState();
    }

  private:
    bool wired_ = false;
    volatile bool held_ = false;
    volatile uint32_t heldAt_ms_ = 0;
};
