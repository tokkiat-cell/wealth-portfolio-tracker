export type DonutSlice = { label: string; value: number };

interface Props {
  title: string;
  slices: DonutSlice[];
}

const money = (n: number) => Math.round(n).toLocaleString("en-SG");

// Donut + legend. Every slice is also listed with its % and value, so colour is never the only cue.
export function AllocationDonut({ title, slices }: Props) {
  // The ring only draws positive slices (a negative one, such as net short options, cannot be an arc).
  // The legend still lists every slice, with its share of the positive total.
  const ring = slices.filter((s) => s.value > 0);
  const total = ring.reduce((n, s) => n + s.value, 0);
  let offset = 25; // start at 12 o'clock

  return (
    <section className="card">
      <h3>{title}</h3>
      {slices.length === 0 ? (
        <p className="muted">No data.</p>
      ) : (
        <div className="donut-wrap">
          <svg viewBox="0 0 42 42" className="donut" role="img" aria-label={title}>
            <circle className="track" cx="21" cy="21" r="15.9155" fill="none" strokeWidth="6" />
            {ring.map((s, i) => {
              const p = total ? (s.value / total) * 100 : 0;
              const seg = (
                <circle
                  key={s.label}
                  className={`seg${i % 5}`}
                  cx="21"
                  cy="21"
                  r="15.9155"
                  fill="none"
                  strokeWidth="6"
                  strokeDasharray={`${p} ${100 - p}`}
                  strokeDashoffset={offset}
                >
                  <title>{`${s.label}: ${p.toFixed(1)}%`}</title>
                </circle>
              );
              offset -= p;
              return seg;
            })}
          </svg>
          <ul className="legend">
            {slices.map((s, i) => (
              <li key={s.label}>
                <span className={`dot dot${i % 5}`} />
                <span>{s.label}</span>
                <span className="pct">{total ? ((s.value / total) * 100).toFixed(1) : "0.0"}%</span>
                <span className="amt">{money(s.value)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
