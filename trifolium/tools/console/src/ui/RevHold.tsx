import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import * as React from "react";

// A rev held from the console, for an RPM capture. Held only while the button is: the transport
// renews REV_HOLD's 300 ms lease while it holds, so a frozen tab or a pulled cable lets go on its own.
// Letting go of the button, moving off it, the window losing focus or the tab being hidden all
// release it at once. There is no fire: the firmware has no command for it.

/** The firmware these commands arrived in. */
export const FW_CONSOLE_CONTROLS = "2.3.0";
/** How often the blaster is asked whether a rev would be refused, while nothing is held. */
export const POLL_MS = 1000;

/** The parts of DUMP_MOTORS this reads. */
export interface MotorsStatus {
  menuOpen: boolean;
  burstMode: string;
  motors: { enabled: boolean }[];
}

export interface RevHoldApi {
  /** Revs the motors in `mask` until the returned function lets go. onLost: the blaster refused. */
  hold: (mask: number, onLost: () => void) => () => void;
  status: () => Promise<MotorsStatus | null>;
}

export interface RevHoldProps {
  api: RevHoldApi;
  live: boolean;
}

export function RevHold({ api, live }: RevHoldProps) {
  const [status, setStatus] = React.useState<MotorsStatus | null>(null);
  /** Motors unticked by hand. Every enabled motor starts ticked. */
  const [unticked, setUnticked] = React.useState<Set<number>>(new Set());
  const [holding, setHolding] = React.useState(false);
  const release = React.useRef<(() => void) | null>(null);

  React.useEffect(() => {
    if (!live) {
      setStatus(null);
      return;
    }
    let stopped = false;
    const poll = async () => {
      if (release.current) return; // the renewals' refusals say it while holding
      const next = await api.status();
      if (!stopped) setStatus(next);
    };
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [api, live]);

  const enabled = (status?.motors ?? []).flatMap((m, i) => (m.enabled ? [i] : []));
  const mask = enabled.filter((i) => !unticked.has(i)).reduce((m, i) => m | (1 << i), 0);

  const blocked = !live
    ? "Connect a blaster to rev it from here."
    : !status
      ? "Reading the blaster..."
      : status.menuOpen
        ? "The blaster's menu is open."
        : status.burstMode === "safe"
          ? "The blaster is in SAFE."
          : !mask
            ? "Tick a motor to rev."
            : null;

  const stop = React.useCallback(() => {
    if (!release.current) return;
    release.current();
    release.current = null;
    setHolding(false);
  }, []);

  const start = () => {
    if (blocked || release.current) return;
    release.current = api.hold(mask, () => {
      release.current = null;
      setHolding(false);
    });
    setHolding(true);
  };

  // Anything that takes the pointer or the page away from the button lets go.
  React.useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") stop();
    };
    const onBlur = () => stop();
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onHidden);
      stop();
    };
  }, [stop]);

  React.useEffect(() => {
    if (!live) stop();
  }, [live, stop]);

  const toggle = (i: number) =>
    setUnticked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <Stack spacing={0.75} sx={{ mt: 1 }}>
      {enabled.length > 0 && (
        <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }}>
          {enabled.map((i) => (
            <FormControlLabel
              key={i}
              control={
                <Checkbox
                  size="small"
                  checked={!unticked.has(i)}
                  disabled={holding}
                  onChange={() => toggle(i)}
                />
              }
              disableTypography
              label={<Typography variant="caption">Motor {i + 1}</Typography>}
              sx={{ m: 0, gap: 0.25 }}
            />
          ))}
        </Stack>
      )}
      <Box>
        <Button
          size="small"
          variant={holding ? "contained" : "outlined"}
          color={holding ? "warning" : "primary"}
          disabled={!!blocked && !holding}
          onPointerDown={(e) => {
            e.preventDefault();
            start();
          }}
          onPointerUp={() => stop()}
          onPointerLeave={() => stop()}
          onPointerCancel={() => stop()}
          onKeyDown={(e) => {
            if ((e.key === " " || e.key === "Enter") && !e.repeat) start();
          }}
          onKeyUp={(e) => {
            if (e.key === " " || e.key === "Enter") stop();
          }}
          onBlur={() => stop()}
          onContextMenu={(e) => e.preventDefault()}
          sx={{ touchAction: "none", userSelect: "none" }}
        >
          {holding ? "Revving - let go to stop" : "Hold to rev"}
        </Button>
      </Box>
      {blocked && !holding && (
        <Typography variant="caption" color="text.disabled">
          {blocked}
        </Typography>
      )}
    </Stack>
  );
}
