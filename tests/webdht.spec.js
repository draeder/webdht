import { test, expect } from '@playwright/test';

function roomId() {
  return `pw-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

test.describe('WebDHT demo (public signaling)', () => {
  function attachPageConsole(page, tag) {
    const prefix = tag ? `[${tag}]` : '[page]';
    page.on('console', (msg) => {
      // Keep it readable: type + text only.
      // (Playwright's ConsoleMessage args can be large / cyclic.)
      try {
        console.log(`${prefix}[console.${msg.type()}] ${msg.text()}`);
      } catch {
        // ignore
      }
    });

    page.on('pageerror', (err) => {
      try {
        console.log(`${prefix}[pageerror] ${String(err?.message || err)}`);
      } catch {
        // ignore
      }
    });

    page.on('requestfailed', (req) => {
      try {
        console.log(`${prefix}[requestfailed] ${req.method()} ${req.url()} ${req.failure()?.errorText || ''}`.trim());
      } catch {
        // ignore
      }
    });
  }

  async function clientId(page) {
    const code = page.locator('header .node-info p').filter({ hasText: 'Node ID:' }).locator('code');
    await expect(code).toBeVisible();
    const title = await code.getAttribute('title');
    return String(title || '').trim();
  }

  let peerSeq = 0;
  async function openPeer(browser, room, { minPeers = 2, maxPeers = 3, browserName = 'unknown' } = {}) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const seq = peerSeq++;
    attachPageConsole(page, `${browserName}:peer${seq}:${room}`);
    await page.goto(`/?room=${encodeURIComponent(room)}&minPeers=${encodeURIComponent(String(minPeers))}&maxPeers=${encodeURIComponent(String(maxPeers))}`);
    await expect(page.getByRole('heading', { name: 'WebDHT' })).toBeVisible();
    // Wait for signaling to go online.
    await expect(page.getByText(/Online/i)).toBeVisible();
    return { context, page };
  }

  test('shows Unsea public key in header', async ({ page }, testInfo) => {
    attachPageConsole(page, `${testInfo.project.name}:single`);
    await page.goto('/');
    await expect(page.getByText('Pub Key:')).toBeVisible();

    const pubKeyCode = page.locator('header .node-info code').nth(1);
    await expect(pubKeyCode).toBeVisible();
    await expect(pubKeyCode).not.toHaveText('');
  });

  test('IndexedDB quota defaults to normal and persists', async ({ page }, testInfo) => {
    attachPageConsole(page, `${testInfo.project.name}:single`);
    await page.goto('/');

    const settings = page.locator('section.settings');
    const select = settings.locator('select').first();

    await expect(settings.getByText('IndexedDB quota:')).toBeVisible();
    await expect(select).toHaveValue('normal');

    await select.selectOption('low');
    await expect(select).toHaveValue('low');

    await page.reload();
    await expect(settings.locator('select').first()).toHaveValue('low');
  });

  test('storage subscribe updates on local put (event-based)', async ({ page }, testInfo) => {
    attachPageConsole(page, `${testInfo.project.name}:single`);
    await page.goto('/');

    const storage = page.locator('section.storage');

    await storage.locator('select').first().selectOption('public');
    await storage.locator('input').nth(0).fill('pw-key');
    await storage.locator('input').nth(1).fill('pw-val-1');

    await storage.getByRole('button', { name: 'Subscribe' }).click();
    await expect(storage.getByText('Subscribed:')).toContainText('public:pw-key');

    await storage.getByRole('button', { name: 'Put' }).click();

    // Subscription should update immediately (no polling).
    await expect(storage.getByText(/Subscription update/i)).toBeVisible();
    await expect(storage.getByText('Result:')).toBeVisible();
    await expect(storage.getByText('pw-val-1')).toBeVisible();
  });

  test('private get does not claim local when missing', async ({ page }, testInfo) => {
    attachPageConsole(page, `${testInfo.project.name}:single`);
    await page.goto('/');

    const storage = page.locator('section.storage');

    await storage.locator('select').first().selectOption('private');
    await storage.locator('input').nth(0).fill('missing-key');
    await storage.getByRole('button', { name: 'Get' }).click();

    await expect(storage.getByText(/Not found locally in private/i)).toBeVisible();
  });

  test('public put on one peer can be fetched by another', async ({ browser, browserName }) => {
    test.setTimeout(180_000);
    const room = roomId();
    async function peerCounts(page) {
      const peersSection = page.locator('section.peers');
      const total = await peersSection.locator('li.peer-item').count();
      const direct = await peersSection.locator('[data-peer-kind="direct"]').count();
      const indirect = await peersSection.locator('[data-peer-kind="indirect"]').count();
      return { direct, indirect, total };
    }

    const a = await openPeer(browser, room, { minPeers: 2, maxPeers: 3, browserName });
    const b = await openPeer(browser, room, { minPeers: 2, maxPeers: 3, browserName });

    // Make sure the room isn't partitioned: wait until each sees at least one peer.
    await expect(a.page.locator('section.peers .peer-item').first()).toBeVisible({ timeout: 60_000 });
    await expect(b.page.locator('section.peers .peer-item').first()).toBeVisible({ timeout: 60_000 });

    // Subscribe on B first, then Put on A; this avoids relying on request/response timing.
    const storageB = b.page.locator('section.storage');
    await storageB.locator('select').first().selectOption('public');
    await storageB.locator('input').nth(0).fill('pw-public');
    await storageB.getByRole('button', { name: 'Subscribe' }).click();
    await expect(storageB.getByText(/Subscribed:/i)).toContainText('public:pw-public');

    const storageA = a.page.locator('section.storage');
    await storageA.locator('select').first().selectOption('public');
    await storageA.locator('input').nth(0).fill('pw-public');
    await storageA.locator('input').nth(1).fill('pw-public-val');
    await storageA.getByRole('button', { name: 'Put' }).click();
    await expect(storageA.getByText(/Stored in public/i)).toBeVisible();

    await expect(storageB.getByText(/Subscription update/i)).toBeVisible({ timeout: 60_000 });
    await expect(storageB.getByText('Result:')).toBeVisible({ timeout: 60_000 });
    await expect(storageB.getByText('pw-public-val')).toBeVisible({ timeout: 60_000 });

    await a.context.close();
    await b.context.close();
  });

  test('frozen keys are immutable (UI enforcement)', async ({ page }, testInfo) => {
    attachPageConsole(page, `${testInfo.project.name}:single`);
    await page.goto('/');
    const storage = page.locator('section.storage');

    await storage.locator('select').first().selectOption('frozen');
    await storage.locator('input').nth(0).fill('pw-frozen');
    await storage.locator('input').nth(1).fill('v1');
    await storage.getByRole('button', { name: 'Put' }).click();
    await expect(storage.getByText(/Stored in frozen|Stored locally in frozen/i)).toBeVisible();
    await expect(storage.getByText('v1')).toBeVisible();

    await storage.locator('input').nth(1).fill('v2');
    await storage.getByRole('button', { name: 'Put' }).click();
    await expect(storage.getByText(/Frozen key already set/i)).toBeVisible();
    await expect(storage.getByText('v1')).toBeVisible();
  });

  test('indirect peers appear and direct message can reach an indirect peer', async ({ browser, browserName }, testInfo) => {
    test.setTimeout(240_000);
    const room = roomId();

    async function peerCounts(page) {
      const peersSection = page.locator('section.peers');
      const total = await peersSection.locator('li.peer-item').count();
      const direct = await peersSection.locator('[data-peer-kind="direct"]').count();
      const indirect = await peersSection.locator('[data-peer-kind="indirect"]').count();
      return { direct, indirect, total };
    }

    // Build a mesh big enough that an indirect peer likely exists.
    // We adaptively spawn peers until the sender observes an indirect.
    const peers = [];
    const maxPeersToSpawn = 10;

    async function indexPagesById() {
      const pages = peers.map((p) => p.page);
      const ids = await Promise.all(pages.map((p) => clientId(p)));
      return new Map(ids.map((id, idx) => [id, pages[idx]]));
    }

    for (let i = 0; i < 4; i++) peers.push(await openPeer(browser, room, { minPeers: 2, maxPeers: 3, browserName }));

    let sender = null;
    let indirectPeerId = '';
    let lastCountsLine = '';
    let lastCountsSnapshot = '';

    const start = Date.now();
    while (!sender || !indirectPeerId) {
      // Emit counts in near-real-time (log only when changed).
      try {
        const pages = peers.map((p) => p.page);
        const ids = await Promise.all(pages.map((p) => clientId(p).catch(() => 'unknown')));
        const counts = await Promise.all(
          pages.map((p) => peerCounts(p).catch(() => ({ direct: -1, indirect: -1, total: -1 }))),
        );

        lastCountsLine = ids
          .map((id, idx) => {
            const c = counts[idx];
            const short = String(id || 'unknown').slice(0, 8);
            return `${short} d${c.direct} i${c.indirect} t${c.total}`;
          })
          .join(' | ');

        if (lastCountsLine !== lastCountsSnapshot) {
          lastCountsSnapshot = lastCountsLine;
          console.log(`[indirect-test] ${lastCountsLine}`);
        }
      } catch {
        // best-effort
      }

      // Look for ANY page that currently shows an indirect peer.
      for (const candidatePeer of peers) {
        const page = candidatePeer.page;
        const peersSection = page.locator('section.peers');
        const indirectItem = peersSection.locator('li.peer-item:has(span.peer-kind[data-peer-kind="indirect"])').first();

        if (await indirectItem.count()) {
          const candidateId = String((await indirectItem.getAttribute('data-peer-id')) || '').trim();
          if (candidateId) {
            sender = page;
            indirectPeerId = candidateId;
            break;
          }
        }
      }

      if (sender && indirectPeerId) break;

      if (peers.length < maxPeersToSpawn) {
        peers.push(await openPeer(browser, room, { minPeers: 2, maxPeers: 3, browserName }));
      }

      if (Date.now() - start > 120_000) break;
      await peers[0].page.waitForTimeout(1500);
    }

    try {
      await testInfo.attach('peer-counts', {
        body: `${lastCountsLine || '(no counts captured)'}\n`,
        contentType: 'text/plain',
      });
    } catch {
      // ignore
    }

    expect(indirectPeerId, `No indirect peer found. Last counts: ${lastCountsLine || '(none)'}`).not.toBe('');

    const pageById = await indexPagesById();
    const targetPage = pageById.get(indirectPeerId);
    expect(targetPage, `Expected to find a page for peerId ${indirectPeerId}`).toBeTruthy();

    const msg = `hello-indirect-${Date.now()}`;
    const messaging = sender.locator('section.messaging');
    await messaging.locator('select').first().selectOption(indirectPeerId);
    await messaging.locator('input').first().fill(msg);
    await messaging.getByRole('button', { name: 'Send' }).click();

    await expect(targetPage.getByText(msg)).toBeVisible({ timeout: 90_000 });

    for (const { context } of peers) await context.close();
  });

  test('can open many peers (20 pages) with minPeers=2 maxPeers=3', async ({ browser, browserName }) => {
    test.setTimeout(240_000);
    // This is a smoke/stress test. We don’t assert WebRTC connectivity because
    // public signaling + WebRTC in CI/headless can be flaky.
    const room = roomId();
    const pages = [];

    const total = 20;
    const concurrency = browserName === 'webkit' ? 2 : 4;
    let nextIndex = 0;

    async function spawnOne() {
      const context = await browser.newContext();
      const page = await context.newPage();
      attachPageConsole(page, `${browserName}:stress:${room}`);
      pages.push({ context, page });
      await page.goto(`/?room=${encodeURIComponent(room)}&minPeers=2&maxPeers=3`);
      await expect(page.getByRole('heading', { name: 'WebDHT' })).toBeVisible();
    }

    const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
      while (true) {
        const current = nextIndex;
        nextIndex += 1;
        if (current >= total) return;
        await spawnOne();
      }
    });

    await Promise.all(workers);

    // Basic sanity: each page shows a Node ID.
    for (const { page } of pages) {
      await expect(page.getByText('Node ID:')).toBeVisible();
    }

    for (const { context } of pages) await context.close();
  });
});
