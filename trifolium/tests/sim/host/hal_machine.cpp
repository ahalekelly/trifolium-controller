// The fake board's clock, and the scheduler that runs the firmware's two cores against it. Each
// core is a fiber on the host's one thread, so handing over is a stack switch rather than a wake-up
// the OS has to schedule, which a loaded machine delays.

#ifndef _WIN32
#define _XOPEN_SOURCE 600 // for ucontext.h on macOS
#endif

#include "hal/detail.h"
#include "hal/hal.h"
#include "hal/machine.h"

#include <cstdint>
#include <cstdlib>
#include <limits>

#ifdef _WIN32
// Not <windows.h>, whose INPUT collides with Arduino's.
extern "C"
{
__declspec(dllimport) void* __stdcall ConvertThreadToFiber(void* parameter);
__declspec(dllimport) void* __stdcall CreateFiber(size_t stack, void(__stdcall* start)(void*),
                                                  void* parameter);
__declspec(dllimport) void __stdcall SwitchToFiber(void* fiber);
__declspec(dllimport) void __stdcall DeleteFiber(void* fiber);
}
#else
#include <sys/mman.h>
#include <type_traits>
#include <ucontext.h>
#include <unistd.h>
#endif

// Common.h declares setup() and loop(); arduino-pico's main.cpp declares these two itself.
void setup1();
void loop1();

namespace
{
constexpr uint64_t kNever = std::numeric_limits<uint64_t>::max();
constexpr int kCore0 = 0;
constexpr int kCore1 = 1;
constexpr int kHost = 2;

// Thrown into a parked core to unwind it when the machine is halted.
struct CoreStop
{
};

uint64_t clock_us = 0;
uint32_t tick_us = 1;
bool pendingPowerLoss = false;

struct Sched
{
    bool active = false;
    uint64_t wakeAt[3] = {kNever, kNever, kNever};
    bool live[2] = {false, false};
    bool unwinding = false;
    hal::Stop stop = hal::Stop::None;
    std::string detail;
};

Sched s;
int self = kHost;

constexpr size_t kStack = 1 << 20;

void coreMain(int id);

#ifdef _WIN32
void* fibers[3];

void __stdcall fiberMain(void* id)
{
    coreMain((int)(intptr_t)id);
}

void makeCore(int id)
{
    if (!fibers[kHost])
        fibers[kHost] = ConvertThreadToFiber(nullptr);
    if (fibers[id])
        DeleteFiber(fibers[id]);
    fibers[id] = CreateFiber(kStack, fiberMain, (void*)(intptr_t)id);
    if (!fibers[kHost] || !fibers[id])
        std::abort();
}

void switchFiber(int, int to)
{
    SwitchToFiber(fibers[to]);
}
#else
// getcontext() fills an mcontext stored right after the ucontext_t. macOS declares a ucontext_t
// without that storage when its headers come before _XOPEN_SOURCE, as the force-included
// heap_count.h makes them, so it is reserved here.
struct Context
{
    ucontext_t uc;
    std::remove_pointer_t<mcontext_t> mc;
};
Context contexts[3];
// Page-aligned for 4 and 16 KB pages. The lowest page is a guard, so an overflow faults.
alignas(1 << 14) char stacks[2][kStack];

void makeCore(int id)
{
    const size_t page = sysconf(_SC_PAGESIZE);
    if (mprotect(stacks[id], page, PROT_NONE))
        std::abort();
    ucontext_t& uc = contexts[id].uc;
    getcontext(&uc);
    uc.uc_stack.ss_sp = stacks[id] + page;
    uc.uc_stack.ss_size = kStack - page;
    uc.uc_link = nullptr;
    makecontext(&uc, (void (*)())coreMain, 1, id);
}

void switchFiber(int from, int to)
{
    swapcontext(&contexts[from].uc, &contexts[to].uc);
}
#endif

bool schedulable(int who)
{
    return who == kHost || (s.live[who] && s.stop == hal::Stop::None);
}

// Earliest wake time wins. On a tie, whoever comes after `self`, so a core that yields on a clock
// read lets an equally due peer go first.
int pickNext()
{
    int best = -1;
    for (int k = 1; k <= 3; k++)
    {
        const int who = (self + k) % 3;
        if (!schedulable(who))
            continue;
        if (best < 0 || s.wakeAt[who] < s.wakeAt[best])
            best = who;
    }
    return best;
}

void handTo(int next)
{
    const int me = self;
    self = next;
    switchFiber(me, next);
    self = me;
    if (self != kHost && s.unwinding)
        throw CoreStop{};
}

void yieldNow()
{
    const int next = pickNext();
    if (s.wakeAt[next] != kNever && s.wakeAt[next] > clock_us)
        clock_us = s.wakeAt[next];
    if (next != self)
        handTo(next);
}

const char* coreName(int id)
{
    return id == kCore0 ? "core 0" : "core 1";
}

void coreBody(int id)
{
    hal::detail::heapCountCaller(id);

    hal::Stop why = hal::Stop::None;
    std::string detail;
    try
    {
        if (s.unwinding)
            throw CoreStop{};
        // arduino-pico's main1() and main(), less the serialEvent hooks nothing here defines. The
        // tick after each pass stands in for the loop's own cost, so no pass is free.
        if (id == kCore0)
        {
            setup();
            for (;;)
            {
                loop();
                hal::detail::onClockRead();
            }
        }
        else
        {
            setup1();
            for (;;)
            {
                loop1();
                hal::detail::onClockRead();
            }
        }
    }
    catch (const CoreStop&)
    {
    }
    catch (const hal::Reboot& r)
    {
        why = r.toBootloader ? hal::Stop::RebootToBootloader : hal::Stop::Reboot;
    }
    catch (const hal::Panic& p)
    {
        why = hal::Stop::Panic;
        detail = p.message;
    }
    catch (const hal::PowerLoss&)
    {
        why = hal::Stop::PowerLoss;
    }
    catch (const std::exception& e)
    {
        why = hal::Stop::Exception;
        detail = e.what();
    }
    catch (...)
    {
        why = hal::Stop::Exception;
        detail = "unknown exception";
    }

    s.live[id] = false;
    s.wakeAt[id] = kNever;
    // A reboot or a fault stops the chip, not one core: the other never runs again.
    if (why != hal::Stop::None && s.stop == hal::Stop::None)
    {
        s.stop = why;
        s.detail = std::string(coreName(id)) + (detail.empty() ? "" : ": " + detail);
    }
}

// A fiber has nowhere to return to, so a finished core hands back to the test for good.
void coreMain(int id)
{
    coreBody(id);
    self = kHost;
    switchFiber(id, kHost);
}
} // namespace

namespace hal::detail
{
uint64_t now_us()
{
    return clock_us;
}

void resetClock()
{
    clock_us = 0;
    tick_us = 1;
    pendingPowerLoss = false;
}

void setTickPerRead_us(uint32_t us)
{
    tick_us = us;
}

void advance_us(uint64_t us)
{
    clock_us += us;
}

void stall_us(uint64_t us)
{
    clock_us += us;
}

void powerLost()
{
    pendingPowerLoss = true;
}

void throwIfPowerLost()
{
    if (pendingPowerLoss && s.active && self != kHost)
    {
        pendingPowerLoss = false;
        throw hal::PowerLoss{};
    }
}

void spend_us(uint64_t us)
{
    throwIfPowerLost();
    clock_us += us;
    if (!s.active || self == kHost)
        return;
    for (int who = 0; who < 3; who++)
    {
        if (who != self && schedulable(who) && s.wakeAt[who] <= clock_us)
        {
            s.wakeAt[self] = clock_us;
            yieldNow();
            return;
        }
    }
}

int currentCore()
{
    return self == kHost ? -1 : self;
}

bool machineRunning()
{
    return s.active;
}

void sleep_us(uint64_t us)
{
    throwIfPowerLost();
    if (!s.active || self == kHost)
    {
        clock_us += us;
        return;
    }
    s.wakeAt[self] = clock_us + us;
    yieldNow();
}

void onClockRead()
{
    throwIfPowerLost();
    clock_us += tick_us;
    if (!s.active || self == kHost)
        return;
    for (int who = 0; who < 3; who++)
    {
        if (who != self && schedulable(who) && s.wakeAt[who] <= clock_us)
        {
            s.wakeAt[self] = clock_us;
            yieldNow();
            return;
        }
    }
}
} // namespace hal::detail

namespace hal
{
Stop lastStop()
{
    return s.stop;
}

Machine::~Machine()
{
    halt();
}

void Machine::start()
{
    halt();
    s.active = true;
    s.unwinding = false;
    s.stop = Stop::None;
    s.detail.clear();
    s.wakeAt[kCore0] = s.wakeAt[kCore1] = clock_us;
    s.wakeAt[kHost] = kNever;
    s.live[kCore0] = s.live[kCore1] = true;
    makeCore(kCore0);
    makeCore(kCore1);
}

bool Machine::run_us(uint64_t us)
{
    if (!s.active || s.stop != Stop::None)
        return false;
    s.wakeAt[kHost] = clock_us + us;
    yieldNow();
    s.wakeAt[kHost] = kNever;
    return s.stop == Stop::None;
}

bool Machine::stopped() const
{
    return s.stop != Stop::None;
}

Stop Machine::stop() const
{
    return s.stop;
}

const std::string& Machine::stopDetail() const
{
    return s.detail;
}

void Machine::halt()
{
    if (!s.active)
        return;
    s.unwinding = true;
    for (int id : {kCore0, kCore1})
    {
        if (s.live[id])
            handTo(id);
    }
    s.unwinding = false;
    s.active = false;
}
} // namespace hal
