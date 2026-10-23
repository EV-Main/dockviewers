//! The keyboard surface, through the same `on_key` a binding feeds: what the framework claims
//! globally, what waits behind the leader, and how a keystroke is identified across layouts.

use std::{cell::RefCell, collections::HashMap, rc::Rc};

use tilers_core::{
	Config, Group, GroupId, MinSize, PackedState, PanelId, Saved, Step,
	keys::{Binding, Chord, Command, KeyInput, KeyOutcome, Keymap, Node},
	model::packed::PackedGrid,
};

/// `"Alt+t s Shift+u !Ctrl+z"`: space-separated keydowns, `+`-joined modifiers, a leading `!` aims
/// the key at an editable. A bare `Shift` is a modifier-only keydown; an uppercase letter is shifted.
fn seq(s: &str) -> Vec<KeyInput> {
	s.split_whitespace()
		.map(|tok| {
			let (editable, tok) = tok.strip_prefix('!').map_or((false, tok), |t| (true, t));
			let mut parts: Vec<&str> = tok.split('+').collect();
			let key = parts.pop().expect("split yields at least one part");
			let has = |m: &str| parts.contains(&m);
			let shift = has("Shift") || (key.len() == 1 && key.chars().all(|c| c.is_ascii_uppercase()));
			let key = if shift && key.len() == 1 { key.to_ascii_uppercase() } else { key.to_string() };
			let code = match key.chars().next() {
				Some(c) if key.len() == 1 && c.is_ascii_alphabetic() => format!("Key{}", c.to_ascii_uppercase()),
				Some(c) if key.len() == 1 && c.is_ascii_digit() => format!("Digit{c}"),
				_ => key.clone(),
			};
			KeyInput {
				key,
				code,
				ctrl: has("Ctrl"),
				alt: has("Alt"),
				meta: has("Meta"),
				shift,
				editable,
			}
		})
		.collect()
}

fn raw(key: &str, code: &str, alt: bool, shift: bool) -> KeyInput {
	KeyInput {
		key: key.into(),
		code: code.into(),
		ctrl: false,
		alt,
		meta: false,
		shift,
		editable: false,
	}
}

/// Two tiles, tile 0 focused, and one structural edit in the undo history — fed the way a binding's
/// undo effect feeds it. Returns the layout before the edit, which is where an undo lands.
fn edited(cfg: Config) -> (PackedState, PackedGrid) {
	let mut s = seeded(cfg);
	let before = s.grid().clone();
	s.resize(0, 20, 12);
	s.capture_undo();
	assert_ne!(s.grid(), &before, "the edit must be visible for an undo to be observable");
	(s, before)
}

fn seeded(cfg: Config) -> PackedState {
	let mut s = PackedState::new(cfg);
	let mins = (0..2).map(|i| (PanelId(format!("p{i}")), MinSize::Steps { w: Step(1), h: Step(1) })).collect();
	s.set_mins(mins);
	s.set_measure((0.0, 0.0), (1600.0, 900.0));
	assert_eq!(s.take_band(), Some(false), "first measure is a miss natively");
	for i in 0..2 {
		let gid = s.mint_group_id();
		s.place(Group::new(gid, PanelId(format!("p{i}"))), 10, 8);
	}
	s.capture_undo();
	s.focus(GroupId(0));
	s
}

fn press(s: &mut PackedState, keys: Vec<KeyInput>) -> Vec<KeyOutcome> {
	keys.into_iter().map(|k| s.on_key(k)).collect()
}

#[derive(Debug, PartialEq)]
enum Lands {
	Edited,
	Undone,
}

/// Press `keys` on the [`edited`] fixture and assert where the layout ends up, and whether the last
/// keydown was `preventDefault`ed.
#[track_caller]
fn check(cfg: Config, keys: Vec<KeyInput>, lands: Lands, prevented: bool) {
	let (mut s, before) = edited(cfg);
	let after_edit = s.grid().clone();
	let outs = press(&mut s, keys);
	let got = match s.grid() {
		g if *g == before => Lands::Undone,
		g if *g == after_edit => Lands::Edited,
		g => panic!("landed on a layout that was never captured: {:?}", g.cells),
	};
	assert_eq!(got, lands);
	assert_eq!(outs.last().expect("at least one key").prevent_default, prevented, "last keydown's preventDefault");
}

fn help_rows(s: &mut PackedState) -> Vec<(String, String)> {
	if s.help(&HashMap::new()).is_none() {
		press(s, seq("Alt+t ?"));
	}
	s.help(&HashMap::new()).expect("leader ? opens the help").rows
}

fn flat() -> Keymap {
	let mut k = Keymap::default();
	k.root.append(&mut k.scope);
	k
}

#[test]
fn bare_keys_are_not_ours() {
	for keys in ["u", "U", "f", "d", "?", "Backspace", "Alt+s", "Alt+S", "Shift U"] {
		let (mut s, _) = edited(Config::default());
		let grid = s.grid().clone();
		for out in press(&mut s, seq(keys)) {
			assert!(!out.prevent_default && !out.changed, "{keys:?} must reach the host untouched");
		}
		assert_eq!(s.grid(), &grid, "{keys:?}");
		assert!(s.help(&HashMap::new()).is_none() && s.hint().is_none() && s.inspect().is_empty(), "{keys:?}");
	}
}

#[test]
fn leader_scope() {
	check(Config::default(), seq("Alt+t u"), Lands::Undone, true);
	// A modifier-only keydown (pressing Shift on the way to `U`) doesn't cancel the scope.
	check(Config::default(), seq("Alt+t u Alt+t Shift U"), Lands::Edited, true);
	check(Config::default(), seq("Alt+t j u"), Lands::Edited, false);
	// A held leader key-repeats; the repeat resets to the leader level instead of cancelling.
	check(Config::default(), seq("Alt+t Alt+t u"), Lands::Undone, true);
}

#[test]
fn hint_follows_the_pending_scope() {
	let (mut s, _) = edited(Config::default());
	assert!(s.hint().is_none());
	press(&mut s, seq("Alt+t"));
	let h = s.hint().expect("an open scope shows its hint");
	assert_eq!(h.prefix, "Alt+t");
	assert!(h.rows.iter().any(|r| r.label == "Undo" && r.chord == "u" && !r.scope), "{:?}", h.rows);
	press(&mut s, seq("u"));
	assert!(s.hint().is_none(), "a leaf closes the scope");
	press(&mut s, seq("Alt+t"));
	s.cancel_chord();
	assert!(s.hint().is_none(), "window blur cancels");
}

#[test]
fn root_undo() {
	check(Config::default(), seq("Ctrl+z"), Lands::Undone, true);
	check(Config::default(), seq("Ctrl+z Ctrl+Z"), Lands::Edited, true);
	check(Config::default(), seq("Ctrl+z Ctrl+y"), Lands::Edited, true);

	let (mut s, _) = edited(Config::default());
	let out = press(&mut s, seq("!Ctrl+z")).remove(0);
	assert!(!out.prevent_default && !out.changed, "text undo inside an editable stays the browser's");

	let mut s = seeded(Config::default());
	let out = press(&mut s, seq("Ctrl+z")).remove(0);
	assert!(!out.prevent_default, "nothing to undo: the keystroke stays the host's");
}

#[test]
fn an_editable_target_cancels_and_never_acts() {
	check(Config::default(), seq("Alt+t !u"), Lands::Edited, false);
	check(Config::default(), seq("Alt+t !u u"), Lands::Edited, false);
}

#[test]
fn key_identity_survives_layouts() {
	// Russian layout: the `u` key produces `г`.
	check(Config::default(), [seq("Alt+t"), vec![raw("г", "KeyU", false, false)]].concat(), Lands::Undone, true);
	// macOS Option composes: Alt+t produces `†`.
	check(Config::default(), [vec![raw("†", "KeyT", true, false)], seq("u")].concat(), Lands::Undone, true);
	// ...or a dead key.
	check(Config::default(), [vec![raw("Dead", "KeyT", true, false)], seq("u")].concat(), Lands::Undone, true);
	// CapsLock: `U` without Shift is still undo, not redo.
	check(Config::default(), [seq("Alt+t"), vec![raw("U", "KeyU", false, false)]].concat(), Lands::Undone, true);
}

#[test]
fn layout_scope_tracks_what_the_host_wired() {
	let (mut s, _) = edited(Config::default());
	assert!(press(&mut s, seq("Alt+t s")).iter().skip(1).all(|o| !o.prevent_default), "no storage, no hook: the whole layout scope is pruned");
	assert!(!help_rows(&mut s).iter().any(|(k, _)| k.starts_with("Alt+t s")), "{:?}", help_rows(&mut s));

	let cached = Config {
		storage_key: Some("t".into()),
		..Default::default()
	};
	let (mut s, _) = edited(cached);
	let rows = help_rows(&mut s);
	assert!(rows.iter().any(|(k, _)| k == "Alt+t s s"), "{rows:?}");
	assert!(!rows.iter().any(|(k, _)| k == "Alt+t s p"), "publish needs `on_save`: {rows:?}");
	let outs = press(&mut s, seq("Alt+t s p"));
	assert!(!outs[2].prevent_default, "an unbound publish is inert");

	let got = Rc::new(RefCell::new(Vec::new()));
	let sink = got.clone();
	let hooked = Config {
		on_save: Some(Rc::new(move |saved| sink.borrow_mut().push(saved))),
		..Default::default()
	};
	let (mut s, _) = edited(hooked);
	assert!(press(&mut s, seq("Alt+t s p"))[2].prevent_default);
	match got.borrow().as_slice() {
		[Saved::Published { json, .. }] => assert_eq!(json, &s.save()),
		_ => panic!("publish hands exactly one layout to the host"),
	}
	assert!(!press(&mut s, seq("Alt+t s s"))[2].prevent_default, "no storage key: caching would write nothing");
	assert_eq!(got.borrow().len(), 1, "an unbound cache reports nothing to the hook");
}

#[test]
fn flat_keymap_has_no_leader() {
	let cfg = || Config { keymap: flat(), ..Default::default() };
	check(cfg(), seq("u"), Lands::Undone, true);
	let (mut s, _) = edited(cfg());
	let out = press(&mut s, seq("Alt+t")).remove(0);
	assert!(!out.prevent_default && s.hint().is_none(), "an empty scope leaves the leader unbound");
}

#[test]
fn custom_command_in_a_nested_scope() {
	let ran = Rc::new(RefCell::new(0));
	let count = ran.clone();
	let mut keymap = Keymap::default();
	keymap.scope.push(Binding {
		on: Chord { key: "x", .. }.into(),
		node: Node::Scope {
			label: "extra",
			children: vec![Binding {
				on: Chord { key: "y", .. }.into(),
				node: Node::Run(Command::Custom {
					label: "Mark",
					run: Rc::new(move |s: &mut PackedState| {
						assert!(s.grid().cells.len() == 2, "runs against the live layout");
						*count.borrow_mut() += 1;
					}),
				}),
			}],
		},
	});
	let (mut s, _) = edited(Config { keymap, ..Default::default() });
	assert!(press(&mut s, seq("Alt+t x y")).iter().all(|o| o.prevent_default));
	assert_eq!(*ran.borrow(), 1);
	assert!(help_rows(&mut s).contains(&("Alt+t x y".into(), "Mark".into())));
}

#[test]
fn help_lists_every_bound_leaf_once() {
	fn leaves(bs: &[Binding]) -> usize {
		bs.iter()
			.map(|b| match &b.node {
				Node::Run(_) => 1,
				Node::Scope { children, .. } => leaves(children),
				_ => unreachable!("Node has two variants"),
			})
			.sum()
	}
	let k = Keymap::default();
	let cfg = Config {
		storage_key: Some("t".into()),
		on_save: Some(Rc::new(|_| {})),
		..Default::default()
	};
	let (mut s, _) = edited(cfg);
	let rows = help_rows(&mut s);
	assert_eq!(rows.len(), leaves(&k.root) + leaves(&k.scope), "{rows:?}");
	let mut seqs: Vec<&String> = rows.iter().map(|(k, _)| k).collect();
	seqs.sort();
	seqs.dedup();
	assert_eq!(seqs.len(), rows.len(), "every leaf is reached by its own sequence: {rows:?}");
}

#[test]
fn help_names_the_pane_it_was_opened_on() {
	let (mut s, _) = edited(Config::default());
	s.open_help(GroupId(1));
	let titles = HashMap::from([(PanelId("p1".into()), "Orders".to_string())]);
	assert_eq!(s.help(&titles).expect("open_help opens it").pane.as_deref(), Some("Orders"));
	press(&mut s, seq("Escape"));
	assert!(s.help(&titles).is_none());
}

#[test]
fn inspect_and_maximize_act_on_the_focused_pane() {
	let (mut s, _) = edited(Config::default());
	press(&mut s, seq("Alt+t d"));
	assert_eq!(s.inspect().len(), 1, "inspect opens on the focused pane");
	press(&mut s, seq("Alt+t f"));
	assert_eq!(s.frames(&HashMap::new()).len(), 1, "maximize renders the focused pane alone");
}

#[test]
fn undo_mid_resize_leaves_the_gesture_intact() {
	let (mut s, _) = edited(Config::default());
	s.resize_start(1, 500.0, 500.0);
	s.resize_move((560.0, 540.0));
	let mid = s.grid().clone();
	for keys in ["Ctrl+z", "Alt+t u", "Alt+t Backspace"] {
		let outs = press(&mut s, seq(keys));
		assert!(!outs.last().expect("one key").prevent_default, "{keys:?} mid-resize must not act");
		assert_eq!(s.grid(), &mid, "{keys:?}");
	}
	s.resize_move((620.0, 580.0));
	s.resize_end();
	assert!(s.grid().overlaps().is_none());
}

#[test]
#[should_panic(expected = "twice")]
fn duplicate_chord_in_one_scope() {
	let mut keymap = Keymap::default();
	keymap.scope.push(keymap.scope[0].clone());
	PackedState::new(Config { keymap, ..Default::default() });
}

#[test]
#[should_panic(expected = "leader")]
fn leader_collides_with_root() {
	let mut keymap = Keymap::default();
	keymap.root.push(Binding {
		on: keymap.leader,
		node: keymap.scope[0].node.clone(),
	});
	PackedState::new(Config { keymap, ..Default::default() });
}
