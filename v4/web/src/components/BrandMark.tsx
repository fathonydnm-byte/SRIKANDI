import uinsaLogo from '../assets/uinsa-logo.png';

/** Logo UIN Sunan Ampel Surabaya dari aset yang diberikan pemilik aplikasi. */
export function BrandMark({ size = 32 }: { size?: number }) {
  return <img src={uinsaLogo} alt="" width={size} height={size} style={{ objectFit: 'contain' }} />;
}
