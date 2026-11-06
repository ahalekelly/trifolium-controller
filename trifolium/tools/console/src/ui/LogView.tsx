import React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import type { LogLine } from "../serial/transport";

export const clock = (at: number) => new Date(at).toTimeString().slice(0, 8);

export const logToText = (lines: LogLine[]): string =>
  lines.map((l) => `${clock(l.at)} ${l.kind === "in" ? "(device) " : ""}${l.text}`).join("\n");

/**
 * The device conversation.
 *
 * Worth the space it takes: the firmware's replies are the only evidence of what a write actually
 * did - which values were clamped, whether a payload was refused, whether the device rebooted
 * underneath you. Timestamped because "did that just happen, or is it from before?" is the usual
 * question.
 *
 * Controls sit inside the output rather than above it, so they cost no vertical space. They stay
 * visible: hiding them until hover saved nothing and left the log looking like a dead panel.
 */
export function Lines({ lines, dense = true }: { lines: LogLine[]; dense?: boolean }) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const { palette, spacing } = useTheme();
  // Lines are plain elements: a thousand MUI Boxes take several times longer to render.
  const colour: Record<LogLine["kind"], string> = {
    out: palette.text.secondary,
    in: palette.text.primary,
    ok: palette.success.main,
    err: palette.error.main,
  };
  const stampStyle = { color: palette.text.disabled, marginRight: spacing(1) };

  // Pin to the newest line by setting scrollTop rather than calling scrollIntoView: a plain property
  // assignment degrades to a no-op where the DOM is only partly implemented, instead of throwing and
  // taking the render down with it.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <Box
      ref={scrollRef}
      sx={{
        height: "100%",
        overflowY: "auto",
        px: 1,
        py: 0.5,
        fontSize: dense ? 12 : 13,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        lineHeight: 1.5,
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
      }}
    >
      {lines.length === 0 ? (
        <Typography variant="caption" color="text.secondary">
          Nothing yet. Connect a device to see the exchange.
        </Typography>
      ) : (
        lines.map((l, i) => (
          <div key={i} style={{ color: colour[l.kind] }}>
            <span style={stampStyle}>{clock(l.at)}</span>
            {l.kind === "in" ? `(device) ${l.text}` : l.text}
          </div>
        ))
      )}
    </Box>
  );
}
