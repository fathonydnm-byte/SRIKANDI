/** Sapaan berdasarkan jam lokal Asia/Jakarta (PRD §6). */
export function greetingFor(date: Date = new Date()): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Jakarta' }).format(date),
  );
  if (hour >= 4 && hour < 11) return 'Selamat pagi';
  if (hour >= 11 && hour < 15) return 'Selamat siang';
  if (hour >= 15 && hour < 18) return 'Selamat sore';
  return 'Selamat malam';
}

export function formatJakartaDate(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' }).format(date);
}
