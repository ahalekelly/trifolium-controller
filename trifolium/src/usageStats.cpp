#include "usageStats.h"
#include <ArduinoJson.h>
#include <LittleFS.h>
#include "logging.h"

namespace
{
const char* STATS_PATH = "/stats.cfg";

// Recorded by core 0, read and reset by core 1: each a word, so a read sees an old or a new value,
// never half. A reset racing a record that lands the same tick can keep that one record.
volatile uint32_t shotsFired = 0;
volatile uint32_t maxCurrent_mv = 0;
volatile uint32_t maxEscTemp_C = 0;
volatile bool dirty = false;

void toJson(JsonDocument& doc)
{
    doc["shotsFired"] = shotsFired;
    doc["maxCurrent_mv"] = maxCurrent_mv;
    doc["maxEscTemp_C"] = maxEscTemp_C;
}
} // namespace

namespace UsageStats
{
void load()
{
    File f = LittleFS.open(STATS_PATH, "r");
    if (!f)
        return; // nothing recorded yet
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, f);
    f.close();
    if (err)
    {
        logger.error("stats.cfg unreadable (", err.c_str(), "), starting the records over");
        dirty = true;
        return;
    }
    shotsFired = doc["shotsFired"];
    maxCurrent_mv = doc["maxCurrent_mv"];
    maxEscTemp_C = doc["maxEscTemp_C"];
}

void recordShot()
{
    shotsFired = shotsFired + 1;
    dirty = true;
}

void recordCurrent(uint32_t mv)
{
    if (mv <= maxCurrent_mv)
        return;
    maxCurrent_mv = mv;
    dirty = true;
}

void recordEscTemp(uint32_t degC)
{
    if (degC <= maxEscTemp_C)
        return;
    maxEscTemp_C = degC;
    dirty = true;
}

bool unsaved()
{
    return dirty;
}

bool save()
{
    dirty = false;
    JsonDocument doc;
    toJson(doc);
    // Written in place: LittleFS commits a file whole when it closes, and at a few dozen bytes it
    // lives in the directory's own block, so a save is one small commit rather than a new block.
    File f = LittleFS.open(STATS_PATH, "w");
    if (!f)
    {
        dirty = true;
        return false;
    }
    serializeJson(doc, f);
    f.close();
    return true;
}

void reset()
{
    shotsFired = 0;
    maxCurrent_mv = 0;
    maxEscTemp_C = 0;
    dirty = true;
}

void writeJson(Print& out)
{
    JsonDocument doc;
    doc["cmd"] = "DUMP_STATS";
    doc["ok"] = true;
    toJson(doc);
    serializeJson(doc, out);
    out.println();
}
} // namespace UsageStats
