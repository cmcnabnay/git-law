export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

export function timeAgo(iso: string): string {
  if (!iso) return "";
  const diffSec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  const plural = (n: number) => (Math.floor(n) === 1 ? "" : "s");
  const mins = diffSec / 60;
  const hours = mins / 60;
  const days = hours / 24;
  const weeks = days / 7;
  const months = days / 30.44;
  const years = days / 365.25;

  if (diffSec < 60) return `${Math.floor(diffSec)} second${plural(diffSec)} ago`;
  if (mins < 60) return `${Math.floor(mins)} minute${plural(mins)} ago`;
  if (hours < 24) return `${Math.floor(hours)} hour${plural(hours)} ago`;
  if (days < 7) return `${Math.floor(days)} day${plural(days)} ago`;
  if (weeks < 4.345) return `${Math.floor(weeks)} week${plural(weeks)} ago`;
  if (months < 12) return `${Math.floor(months)} month${plural(months)} ago`;
  return `${Math.floor(years)} year${plural(years)} ago`;
}
