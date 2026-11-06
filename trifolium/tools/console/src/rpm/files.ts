// Captures saved as CSV files, named by when they were taken.

/** A local date and time to the second, as file names carry it: 2026-11-05_14-50-37. */
export function fileStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `${date}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** A capture taken by hand: rpm-capture-<now>.csv, so captures a second apart never collide. */
export const captureName = () => `rpm-capture-${fileStamp(new Date())}.csv`;

export function downloadCsv(csv: string, name: string) {
  const url = URL.createObjectURL(new Blob([`${csv}\n`], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
