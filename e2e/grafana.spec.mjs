import { expect, test } from '@playwright/test'

// The Grafana plugin over `nix run .#dev -- grafana`'s testdata fixture, a twin of devops'
// `ev-deployments`. Every testdata query carries `alias: q-<panel id>`, which is how a request is
// attributed to its panel.

const DOCK = 'a/evmain-dockviewers-app/d/dv-fixture'
const PANELS = 9

const boot = async (page, path = DOCK) => {
	await page.goto(path)
	await page.waitForFunction((n) => document.querySelectorAll('.dv-grafana-slot').length === n, PANELS, { timeout: 30_000 })
	// variables resolve, so titles carry `$deployment`'s value
	await expect(page.locator('.dv-tab').first()).toHaveText(/· AA$/)
}

const tab = (page, title) => page.locator('.dv-tab', { hasText: new RegExp(`^${title} ·`) })
/** The overlay box holding panel `id`'s slot. */
const overlay = (page, id) => page.locator(`.dv-render-overlay:has(> .dv-grafana-slot[data-panel="panel-${id}"])`)
const geometry = (page) => page.$$eval('.dv-tile', (els) => els.map((e) => e.getAttribute('style')))

/** Drag `from`'s tab onto `onto`'s header, joining them as tabs. */
const join = async (page, from, onto) => {
	const src = await tab(page, from).boundingBox()
	const dst = await tab(page, onto).boundingBox()
	await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2)
	await page.mouse.down()
	await page.mouse.move(dst.x + dst.width + 30, dst.y + dst.height / 2, { steps: 12 })
	await page.mouse.up()
}

test.beforeEach(async ({ page }) => await boot(page))

test('every panel renders natively inside a tile', async ({ page }) => {
	expect(await page.locator('.dv-tile').count()).toBe(PANELS)
	const inside = await page.$$eval('.dv-grafana-slot', (slots) => {
		const tiles = [...document.querySelectorAll('.dv-tile')].map((t) => t.getBoundingClientRect())
		return slots.map((s) => {
			const r = s.getBoundingClientRect()
			return tiles.some((t) => r.left >= t.left - 1 && r.right <= t.right + 1 && r.top >= t.top - 1 && r.bottom <= t.bottom + 1)
		})
	})
	expect(inside, 'each slot sits within some tile').toEqual(Array(PANELS).fill(true))
	await expect(overlay(page, 11).locator('[data-testid="data-testid panel content"]')).toBeVisible()
})

test('a tab-join switches panels, and the inactive tab stays quiet on refresh', async ({ page }) => {
	await join(page, 'Flux', 'Switch')
	const header = page.locator('.dv-header', { has: tab(page, 'Switch') })
	await expect(header.locator('.dv-tab')).toHaveCount(2)
	await expect(overlay(page, 9)).toBeVisible()
	await expect(overlay(page, 2)).toBeHidden()

	await tab(page, 'Switch').click()
	await expect(overlay(page, 2)).toBeVisible()
	await expect(overlay(page, 9)).toBeHidden()

	const asked = []
	page.on('request', (r) => r.url().includes('/api/ds/query') && asked.push(r.postData() ?? ''))
	await page.getByRole('button', { name: 'Refresh', exact: true }).click()
	await page.waitForLoadState('networkidle')
	expect(asked.some((b) => b.includes('"q-2"')), 'the active tab refreshes').toBe(true)
	expect(asked.some((b) => b.includes('"q-9"')), 'the inactive tab must not query').toBe(false)
})

test('a container-only resize re-measures', async ({ page }) => {
	const before = await page.locator('.dv-tile').first().boundingBox()
	await page.evaluate(() => (document.querySelector('.dv-packed').parentElement.style.right = '400px'))
	await expect.poll(async () => (await page.locator('.dv-tile').first().boundingBox()).width).toBeLessThan(before.width - 50)
})

test('Alt+S then a reload restores the layout', async ({ page }) => {
	await join(page, 'Flux', 'Switch')
	const edited = await geometry(page)
	await page.keyboard.press('Alt+s')
	await page.reload()
	await boot(page, page.url())
	expect(await geometry(page)).toEqual(edited)
})

test('? is Grafana’s shortcuts modal, not the dock hint', async ({ page }) => {
	await page.keyboard.press('Shift+Slash')
	await expect(page.getByRole('dialog')).toBeVisible()
	await expect(page.locator('.dv-help')).toHaveCount(0)
	await page.keyboard.press('Escape')
	await page.keyboard.press('Shift+KeyH')
	await expect(page.locator('.dv-help')).toBeVisible()
})

test('an idle dock does no work beyond a native dashboard', async ({ page }) => {
	await page.waitForLoadState('networkidle')
	const idle = () =>
		page.evaluate(
			() =>
				new Promise((done) => {
					let mutations = 0
					let longTasks = 0
					const root = document.querySelector('.dv-packed')
					const mo = root
						? new MutationObserver((ms) => (mutations += ms.filter((m) => !m.target.closest?.('.dv-grafana-slot') && !m.target.parentElement?.closest('.dv-grafana-slot')).length))
						: undefined
					mo?.observe(root, { subtree: true, childList: true, attributes: true, characterData: true })
					const po = new PerformanceObserver((l) => (longTasks += l.getEntries().length))
					po.observe({ type: 'longtask' })
					setTimeout(() => {
						mo?.disconnect()
						po.disconnect()
						done({ mutations, longTasks })
					}, 5000)
				})
		)
	const dock = await idle()
	expect(dock.mutations, 'the dock chrome is static while nothing moves').toBe(0)

	await page.goto('d/dv-fixture')
	await page.waitForLoadState('networkidle')
	const native = await idle()
	expect(dock.longTasks).toBeLessThanOrEqual(native.longTasks + 1)
})

test('an unsupported dashboard names what it refuses', async ({ page }) => {
	await page.goto('a/evmain-dockviewers-app/d/dv-fixture-repeat')
	await expect(page.getByText('panel 1 "Memory · $deployment" uses repeat')).toBeVisible()
})
