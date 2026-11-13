/** Lokasi fisik ditonjolkan: kegunaan utama Cari Arsip. */
export function LocationBlock({ kabinet, laci, folder, lokasi, size = 'md' }: { kabinet: string | null; laci: string | null; folder: string | null; lokasi: string; size?: 'md' | 'lg' }) {
  const parts: [string, string | null][] = [
    ['Kabinet', kabinet],
    ['Laci', laci],
    ['Folder', folder],
  ];
  const filled = parts.filter(([, v]) => v && v.trim());
  if (!filled.length) {
    return (
      <div className={`location location-${size} location-empty`}>
        <span className="location-pin" aria-hidden="true">📍</span>
        <span>{lokasi || 'Lokasi belum diisi'}</span>
      </div>
    );
  }
  return (
    <div className={`location location-${size}`} aria-label={`Lokasi: ${lokasi}`} role="group">
      <span className="location-pin" aria-hidden="true">📍</span>
      <dl className="location-parts">
        {filled.map(([label, value]) => (
          <div key={label} className="location-part">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
