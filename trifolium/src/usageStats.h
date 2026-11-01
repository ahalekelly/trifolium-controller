#pragma once
#include <Arduino.h>

// Lifetime records kept in LittleFS: darts fired, the highest ESC current-sense reading under load
// and the hottest any ESC reported. Core 0 records into RAM every tick; core 1 saves them once the
// wheels have stopped, since a LittleFS write parks both cores. DUMP_STATS shows them and
// RESET_STATS clears them.
namespace UsageStats
{
// Once from setup(), after LittleFS is mounted.
void load();

void recordShot();
void recordCurrent(uint32_t mv); // the ESC current-sense pin, in mV
void recordEscTemp(uint32_t degC);

struct Records
{
    uint32_t shotsFired;
    uint32_t maxCurrent_mv;
    uint32_t maxEscTemp_C;
};
Records records();

bool unsaved();
// Clears unsaved() first, so a record made during the write is saved next time.
bool save();
void reset();

void writeJson(Print& out);
} // namespace UsageStats
