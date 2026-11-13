export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'failed';

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // jatuh ke cara lama
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.className = 'sr-only';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Web Share API bila ada (HP), selain itu salin teks + tautan ke clipboard. */
export async function shareText(title: string, text: string, url: string): Promise<ShareOutcome> {
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title, text, url });
      return 'shared';
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') return 'cancelled';
      // lanjut ke clipboard
    }
  }
  return (await copyText(`${text}\n${url}`)) ? 'copied' : 'failed';
}
