import React from "react";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

// Rev and Fire, held from the browser. Each acts only while the pointer is down on it: leaving the
// button, the window losing focus or the tab going hidden all let go. The device lets go too if the
// console stops renewing the hold, so a dropped link cannot leave the blaster revving.

export type SwitchRole = "rev" | "trigger";

/** How often a held Rev or Fire renews its hold - well inside the device's 300 ms lapse. */
const RENEW_MS = 100;

const BUTTONS: { role: SwitchRole; label: string }[] = [
  { role: "rev", label: "Rev" },
  { role: "trigger", label: "Fire" },
];

export function ConsoleSwitches({
  blocked,
  onHold,
}: {
  /** Why the buttons cannot be used right now ("" when disconnected), or null when they can. */
  blocked: string | null;
  /** Called with true on press and every RENEW_MS while held, then once with false. */
  onHold: (role: SwitchRole, held: boolean) => void;
}) {
  // Each held button's renewal timer. A ref rather than state, so a press starts exactly one;
  // render() repaints.
  const pressed = React.useRef(new Map<SwitchRole, ReturnType<typeof setInterval>>()).current;
  const [, render] = React.useReducer((n: number) => n + 1, 0);
  const onHoldRef = React.useRef(onHold);
  onHoldRef.current = onHold;

  const press = (role: SwitchRole, held: boolean) => {
    if (pressed.has(role) === held) return;
    if (held) {
      const hold = () => onHoldRef.current(role, true);
      hold();
      pressed.set(role, setInterval(hold, RENEW_MS));
    } else {
      clearInterval(pressed.get(role));
      pressed.delete(role);
      onHoldRef.current(role, false);
    }
    render();
  };

  // Lets go of everything when the page stops being the thing in front of you, when the buttons
  // become blocked, and when they go away.
  React.useEffect(() => {
    const releaseAll = () => [...pressed.keys()].forEach((role) => press(role, false));
    if (blocked !== null) releaseAll();
    const onVisibility = () => document.hidden && releaseAll();
    window.addEventListener("blur", releaseAll);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", releaseAll);
      document.removeEventListener("visibilitychange", onVisibility);
      releaseAll();
    };
  }, [blocked]);

  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
      {BUTTONS.map(({ role, label }) => (
        <Button
          key={role}
          size="small"
          variant={pressed.has(role) ? "contained" : "outlined"}
          disabled={blocked !== null}
          onPointerDown={() => press(role, true)}
          onPointerUp={() => press(role, false)}
          onPointerLeave={() => press(role, false)}
          onPointerCancel={() => press(role, false)}
          onContextMenu={(e) => e.preventDefault()}
          sx={{ touchAction: "none", userSelect: "none" }}
        >
          {label}
        </Button>
      ))}
      {blocked && (
        <Typography variant="caption" color="text.secondary">
          {blocked}
        </Typography>
      )}
    </Stack>
  );
}
