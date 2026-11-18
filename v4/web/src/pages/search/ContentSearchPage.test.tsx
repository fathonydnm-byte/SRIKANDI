import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { createFakeClient, makeProfile, makeSession, type RpcHandler } from '../../test/fakeSupabase';
import { renderApp } from '../../test/renderApp';

it('searches only on submit, reports progress, and links a page match to the archive item', async () => {
  let finish: (value: Awaited<ReturnType<RpcHandler>>) => void = () => {};
  const search = vi.fn<RpcHandler>(() => new Promise((resolve) => { finish = resolve; }));
  const fake = createFakeClient({ profile: makeProfile('PIMPINAN'), session: makeSession(), rpc: { search_scan_content: search } });
  renderApp('/cari-isi', fake.client);
  const user = userEvent.setup();
  const field = await screen.findByRole('searchbox', { name: 'Kata atau frasa' });
  await user.type(field, 'keputusan rektor');
  expect(search).not.toHaveBeenCalled();
  await user.click(screen.getByRole('checkbox', { name: 'Cari frasa berurutan' }));
  await user.click(screen.getByRole('button', { name: /^Cari$/ }));
  expect(await screen.findByText('Sedang mencari isi PDF…')).toBeVisible();
  expect(search).toHaveBeenCalledWith(expect.objectContaining({
    p_query: 'keputusan rektor', p_phrase: true, p_limit: 12, p_offset: 0, p_unit_id: null,
  }), undefined);
  finish({
    error: null,
    data: { results: [{
      item_id: 'ITM-1', berkas_id: 'BRK-1', page_no: 3, no_item: 2, no_berkas: 19,
      title: 'Surat masuk', description: 'Tentang kepanitiaan', unit_code: 'BAGUM',
      snippet: 'Menimbang keputusan rektor tentang kepanitiaan.',
    }], has_more: true },
  });
  expect(await screen.findByRole('link', { name: 'Tentang kepanitiaan' })).toHaveAttribute('href', '/cari/item/ITM-1');
  expect(screen.getByText(/Halaman PDF 3/)).toBeVisible();
  expect(screen.getByText(/Menimbang keputusan rektor/)).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Berikutnya' }));
  expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ p_offset: 12 }), undefined);
});
