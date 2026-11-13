/** Logo Central File (diambil dari aplikasi 3.x). */
export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} fill="none" aria-hidden="true" focusable="false">
      <rect x="20" y="20" width="60" height="60" rx="3" stroke="#0B4D2C" strokeWidth="6" />
      <rect x="20" y="20" width="60" height="60" rx="3" transform="rotate(45 50 50)" stroke="#0B4D2C" strokeWidth="6" />
      <path d="M42 62V44C42 40 45 36 48 36V62" stroke="#C4A163" strokeWidth="4.5" strokeLinecap="round" />
      <path d="M54 62V38C54 34 58 32 62 36V62" stroke="#C4A163" strokeWidth="4.5" strokeLinecap="round" />
    </svg>
  );
}
