/** A coloured initial. The hue comes from the person's id so the same person always looks the same. */
export function Avatar({ id, name, size = 22 }: { id: number; name: string; size?: number }) {
  const hue = (id * 47) % 360;
  return (
    <span
      className="avatar person"
      role="img"
      aria-label={name}
      title={name}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.46),
        background: `oklch(var(--av-l, 0.9) 0.06 ${hue})`,
        color: `oklch(var(--av-ink, 0.38) 0.1 ${hue})`,
      }}
    >
      {name.trim()[0] ?? "?"}
    </span>
  );
}
