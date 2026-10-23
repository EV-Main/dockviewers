//! The wasm half of the Grafana app plugin in `plugin/`: a dashboard's panels hosted in the
//! dockviewers Leptos binding. The plugin's `DockLayout` mounts this and portals each panel's native
//! `VizPanel` into the slot element `on_slot` hands it; everything Grafana-shaped stays on this side
//! of [`mount`].

use std::{collections::HashSet, sync::Arc};

use dockviewers_leptos::{Config, DockPanel, Group, GroupId, Keybind, Keybinds, MinSize, PackedApi, PackedArea, PanelId};
use js_sys::{Function, Map};
use leptos::{
	mount::{UnmountHandle, mount_to},
	prelude::*,
	tachys::view::any_view::AnyViewState,
};
use send_wrapper::SendWrapper;
use wasm_bindgen::prelude::*;
use web_sys::HtmlElement;

/// Grafana's dashboard grid: 24 columns, 30px rows, 8px between rows.
const GRID_COLUMNS: u32 = 24;
const ROW_PX: f64 = 30.0;
const ROW_GAP_PX: f64 = 8.0;

/// One panel: its save-model `gridPos`, in Grafana grid units, and the CSS px its content needs
/// (`0` = nothing beyond the chrome).
#[wasm_bindgen]
pub struct Seed {
	id: PanelId,
	title: String,
	x: u32,
	y: u32,
	w: u32,
	h: u32,
	min_w: f64,
	min_h: f64,
}

#[wasm_bindgen]
impl Seed {
	#[wasm_bindgen(constructor)]
	pub fn new(id: String, title: String, x: u32, y: u32, w: u32, h: u32, min_w: f64, min_h: f64) -> Self {
		assert!(w >= 1 && x + w <= GRID_COLUMNS && h >= 1, "gridPos of {id:?} is off Grafana's grid: x={x} w={w} h={h}");
		assert!(min_w >= 0.0 && min_h >= 0.0, "min of {id:?} is negative: {min_w}x{min_h}");
		Self {
			id: PanelId(id),
			title,
			x,
			y,
			w,
			h,
			min_w,
			min_h,
		}
	}
}

#[wasm_bindgen]
pub struct Dock {
	panels: RwSignal<Vec<DockPanel>>,
	api: StoredValue<Option<PackedApi>>,
	view: UnmountHandle<AnyViewState>,
	owner: Owner, // after `view`: field order is drop order too
}

/// `on_slot(id, el)` fires once per panel, when its overlay slot first mounts; that element stays
/// the panel's for the dock's lifetime. `request_tab(gid)` is the per-tile `+`.
#[wasm_bindgen]
pub fn mount(root: HtmlElement, mut seeds: Vec<Seed>, storage_key: String, on_slot: Function, request_tab: Function) -> Dock {
	console_error_panic_hook::set_once();
	let known: HashSet<PanelId> = seeds.iter().map(|s| s.id.clone()).collect();
	assert!(!seeds.is_empty() && known.len() == seeds.len(), "a dock needs panels, each with its own id");
	seeds.sort_by_key(|s| (s.y, s.x));

	let config = Config {
		storage_key: Some(storage_key),
		keybinds: Keybinds {
			help: Keybind { key: "H", alt: false, ctrl: false }, // `?` is Grafana's shortcuts modal
			..Default::default()
		},
		..Default::default()
	};
	let rows = config.rows;
	let on_slot = SendWrapper::new(on_slot);
	let request_tab = SendWrapper::new(request_tab);
	let root_el = SendWrapper::new(root.clone());

	let owner = Owner::new();
	let (panels, api, view) = owner.with(|| {
		let panels = RwSignal::new(seeds.iter().map(|s| slot(s, &on_slot)).collect::<Vec<_>>());
		let api = StoredValue::new(None);
		let on_band: Arc<dyn Fn(PackedApi) + Send + Sync> = Arc::new(move |a: PackedApi| {
			api.set_value(Some(a));
			if a.restored() {
				let stale: Vec<PanelId> = a.tab_ids().into_iter().filter(|id| !known.contains(id)).collect();
				if stale.is_empty() {
					return;
				}
				web_sys::console::warn_1(&format!("dockviewers_grafana: cached layout hosts panels the dashboard no longer has ({stale:?}); re-seeding").into());
				a.reset();
			}
			let step_h = root_el.client_height() as f64 / rows as f64;
			let cols = a.cols();
			for s in &seeds {
				let w = (s.w as f64 * cols as f64 / GRID_COLUMNS as f64).round() as u32;
				let h = ((s.h as f64 * ROW_PX + (s.h - 1) as f64 * ROW_GAP_PX) / step_h).round() as u32;
				a.place(Group::new(a.mint_group_id(), s.id.clone()), w, h);
			}
		});
		let request_tab: Arc<dyn Fn(GroupId) + Send + Sync> = Arc::new(move |gid: GroupId| {
			request_tab.call1(&JsValue::NULL, &JsValue::from(gid.0)).expect("request_tab handler threw");
		});
		let view = mount_to(root, move || {
			view! { <PackedArea panels=panels config=config on_band=on_band request_tab=request_tab /> }.into_any()
		});
		(panels, api, view)
	});
	Dock { panels, api, view, owner }
}

/// A panel whose content is a bare slot the plugin portals the `VizPanel` into.
fn slot(seed: &Seed, on_slot: &SendWrapper<Function>) -> DockPanel {
	let id = seed.id.clone();
	let on_slot = on_slot.clone();
	DockPanel {
		id: seed.id.clone(),
		title: seed.title.clone(),
		min: MinSize::Px { w: seed.min_w, h: seed.min_h },
		content: Arc::new(move || {
			let node = NodeRef::<leptos::html::Div>::new();
			let (id, on_slot) = (id.clone(), on_slot.clone());
			let key = id.0.clone();
			node.on_load(move |el| {
				on_slot.call2(&JsValue::NULL, &JsValue::from_str(&id.0), &el).expect("on_slot handler threw");
			});
			view! { <div class="dv-grafana-slot" data-panel=key node_ref=node></div> }.into_any()
		}),
	}
}

#[wasm_bindgen]
impl Dock {
	/// Retitle every panel in place (titles interpolate `$variables`); order, and so every mounted
	/// panel, is untouched. `titles` maps each panel id to its title.
	pub fn set_titles(&self, titles: Map) {
		let next: Vec<String> = self.panels.with_untracked(|ps| {
			assert_eq!(titles.size() as usize, ps.len(), "set_titles carries every panel, and only those");
			ps.iter()
				.map(|p| titles.get(&JsValue::from_str(&p.id.0)).as_string().unwrap_or_else(|| panic!("set_titles is missing {:?}", p.id)))
				.collect()
		});
		if self.panels.with_untracked(|ps| ps.iter().map(|p| &p.title).eq(next.iter())) {
			return;
		}
		self.panels.update(|ps| ps.iter_mut().zip(next).for_each(|(p, t)| p.title = t));
	}

	/// Re-declare what `id`'s content needs, in CSS px — a compiled size landing after mount.
	pub fn set_min(&self, id: String, w: f64, h: f64) {
		assert!(w >= 0.0 && h >= 0.0, "min of {id:?} is negative: {w}x{h}");
		let id = PanelId(id);
		let min = MinSize::Px { w, h };
		let i = self
			.panels
			.with_untracked(|ps| ps.iter().position(|p| p.id == id))
			.unwrap_or_else(|| panic!("set_min of unknown panel {id:?}"));
		if self.panels.with_untracked(|ps| ps[i].min == min) {
			return;
		}
		self.panels.update(|ps| ps[i].min = min);
	}

	/// Panel ids the layout hosts; the rest are closed, and are what `+` offers.
	pub fn hosted(&self) -> Vec<String> {
		self.api().tab_ids().into_iter().map(|p| p.0).collect()
	}

	pub fn add_tab(&self, gid: u64, id: String) {
		let id = PanelId(id);
		assert!(self.panels.with_untracked(|ps| ps.iter().any(|p| p.id == id)), "add_tab of unknown panel {id:?}");
		assert!(!self.api().tab_ids().contains(&id), "add_tab of {id:?}, which is already hosted");
		self.api().add_tab(GroupId(gid), id);
	}

	/// The view unmounts before its owner disposes the signals it reads.
	pub fn unmount(self) {
		let Self { view, owner, .. } = self;
		drop(view);
		drop(owner);
	}

	fn api(&self) -> PackedApi {
		self.api.get_value().expect("on_band runs at the first measure, before any tile exists to ask")
	}
}
