import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, keys, appHome, readTextFile } from "herdr";

const MONO = "JetBrains Mono, Menlo, monospace";

const notch = (c, [l, r, t, b]) => [
  div().absolute().left(l + 2).right(r + 2).top(t).bottom(b).bg(c),
  div().absolute().left(l).right(r).top(t + 2).bottom(b + 2).bg(c),
];
const box = (frame, fill, shadow) => [
  ...notch(shadow, [2, 0, 2, 0]),
  ...notch(frame, [0, 2, 0, 2]),
  ...notch(fill, [2, 4, 2, 4]),
];

// Bagian keys.json yang dibaca lembar ini: global, plus "layout:pixel-hq" tempat install.sh/install.ps1 memasang
// hotkey Kanban dan Usage (cuma aktif di layout ini).
const SECTIONS = ["global", "layout:pixel-hq"];

const HOTKEY_CATEGORIES = [
  {
    category: "Pixel HQ",
    items: [
      { action: "mod.open:company-kanban", name: "Papan kanban", desc: "Buka papan kanban: task buat agent" },
      { action: "mod.open:company-usage", name: "Usage Claude", desc: "Buka riwayat usage Claude dan pemakaian per staf" },
    ],
  },
  {
    category: "Lantai (space)",
    items: [
      { action: "mod.open:company-switcher", name: "Pindah lantai", desc: "Buka daftar lantai (tahan Ctrl lalu tekan P berulang buat ganti)" },
      { action: "space.next", name: "Lantai berikutnya", desc: "Pindah ke lantai berikutnya" },
      { action: "space.prev", name: "Lantai sebelumnya", desc: "Pindah ke lantai sebelumnya" },
      { action: "space.new", name: "Lantai baru", desc: "Bikin lantai baru" },
      { action: "space.select:1", name: "Lompat ke lantai 1–9", desc: "Langsung ke lantai 1–9", customKeys: ["alt-1 … alt-9"] },
      { action: "space.rename", name: "Ganti nama lantai", desc: "Ganti nama lantai sekarang" },
    ],
  },
  {
    category: "Bagi panel",
    items: [
      { action: "pane.split:right", name: "Bagi ke kanan", desc: "Bagi panel aktif ke arah kanan" },
      { action: "pane.split:down", name: "Bagi ke bawah", desc: "Bagi panel aktif ke arah bawah" },
      { action: "pane.close", name: "Tutup panel", desc: "Tutup panel aktif" },
      { action: "pane.zoom", name: "Zoom panel", desc: "Perbesar / kembalikan panel aktif" },
      { action: "layout.switch", name: "Ganti layout", desc: "Ganti layout tampilan" },
      { action: "pane.go:left", name: "Pindah fokus", desc: "Pindah fokus ke panel sebelah", customKeys: ["alt-h / j / k / l", "alt-left / right"] },
    ],
  },
  {
    category: "Tab & terminal",
    items: [
      { action: "tab.new", name: "Tab baru", desc: "Buka tab terminal baru di panel aktif" },
      { action: "tab.close", name: "Tutup tab", desc: "Tutup tab terminal sekarang" },
      { action: "tab.next", name: "Tab berikutnya", desc: "Pindah ke tab berikutnya" },
      { action: "tab.prev", name: "Tab sebelumnya", desc: "Pindah ke tab sebelumnya" },
      { action: "tab.select:1", name: "Lompat ke tab 1–9", desc: "Langsung ke tab 1–9", customKeys: ["ctrl-1 … ctrl-9"] },
      { action: "tab.rename", name: "Ganti nama tab", desc: "Ganti nama tab sekarang" },
      { action: "terminal.copy", name: "Salin pilihan", desc: "Salin teks yang dipilih di terminal" },
      { action: "terminal.paste", name: "Tempel", desc: "Tempel isi clipboard ke terminal" },
      { action: "terminal.search", name: "Cari di terminal", desc: "Cari di riwayat output terminal" },
    ],
  },
  {
    category: "Sistem & palet",
    items: [
      { action: "app.palette", name: "Palet perintah", desc: "Buka palet perintah" },
      { action: "app.settings", name: "Pengaturan", desc: "Buka pengaturan aplikasi" },
      { action: "app.help", name: "Bantuan", desc: "Buka bantuan dan dokumentasi" },
      { action: "layout.toggle:sidebar", name: "Sidebar", desc: "Tampilkan / sembunyikan sidebar kiri" },
      { action: "app.zoom_in", name: "Perbesar / perkecil / reset", desc: "Atur ukuran tampilan", customKeys: ["ctrl-+", "ctrl--", "ctrl-0"] },
    ],
  },
];

function formatChord(chord) {
  if (!chord) return "";
  return chord
    .split("-")
    .map((p) => {
      p = p.trim().toLowerCase();
      if (p === "ctrl") return "Ctrl";
      if (p === "alt") return "Alt";
      if (p === "shift") return "Shift";
      if (p === "pagedown") return "PgDn";
      if (p === "pageup") return "PgUp";
      if (p === "escape") return "Esc";
      if (p === "enter") return "Enter";
      return p.toUpperCase();
    })
    .join(" + ");
}

export default class CompanyHotkeys extends View {
  init(_props, cx) {
    this.rawKeys = null;
    this.handle = cx.focus_handle();
    this.handle.focus();

    cx.spawn(async (cx) => {
      try {
        const home = appHome();
        const raw = await readTextFile(`${home}/keys.json`).catch(() => null);
        if (raw) {
          this.rawKeys = JSON.parse(raw);
          cx.notify();
        }
      } catch {}
    });
  }

  closeModal() {
    const ov = props()?.overlay;
    if (ov) {
      closeOverlay(ov);
    } else {
      run("overlay.close");
    }
  }

  getBindingsMap() {
    const map = new Map();

    for (const sec of SECTIONS) {
      const raw = this.rawKeys?.[sec];
      if (!raw || typeof raw !== "object") continue;
      for (const [chord, act] of Object.entries(raw)) {
        if (typeof act !== "string") continue; // binding berbentuk objek ({command, args}) gak ditampilkan di sini
        if (!map.has(act)) map.set(act, []);
        if (!map.get(act).includes(chord)) map.get(act).push(chord);
      }
    }

    const allKeys = keys() ?? [];
    for (const k of allKeys) {
      if (SECTIONS.includes(k.section)) {
        if (!map.has(k.action)) map.set(k.action, []);
        if (!map.get(k.action).includes(k.keys)) {
          map.get(k.action).push(k.keys);
        }
      }
    }

    return map;
  }

  render(cx) {
    const bindingsMap = this.getBindingsMap();

    return v_flex()
      .id("company-hotkeys")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          this.closeModal();
          cx.stop_propagation();
        }
      })
      .size_full()
      .min_h(0)
      .relative()
      .children(box("#45475a", "#181825", "#11111b"))
      .child(
        v_flex()
          .relative()
          .size_full()
          .p(12)
          .gap(8)
          .font_family(MONO)
          .text_size(12)
          .child(
            h_flex()
              .h(30)
              .px(4)
              .pb(6)
              .items_center()
              .justify_between()
              .border_b(1)
              .border_color("#313244")
              .child(
                h_flex()
                  .gap(8)
                  .items_center()
                  .child(svg("mods/company-brand/keyboard.svg").size(15).text_color("#89b4fa"))
                  .child(
                    div()
                      .text_size(12)
                      .font_bold()
                      .text_color("#cdd6f4")
                      .child("DAFTAR HOTKEY"),
                  )
                  .child(
                    div()
                      .px(5)
                      .py(1)
                      .bg("#89b4fa18")
                      .border_1()
                      .border_color("#89b4fa44")
                      .text_size(9)
                      .font_bold()
                      .text_color("#89b4fa")
                      .child("CUMA BACA"),
                  ),
              )
              .child(
                h_flex()
                  .id("btn-esc-hotkeys")
                  .relative()
                  .h(22)
                  .px(8)
                  .items_center()
                  .justify_center()
                  .cursor_pointer()
                  .children(box("#45475a", "#313244", "#11111b"))
                  .hover((s) => s.text_color("#ffffff"))
                  .on_click((_e, _cx) => this.closeModal())
                  .child(
                    div()
                      .font_family(MONO)
                      .text_size(9.5)
                      .font_bold()
                      .text_color("#a6adc8")
                      .child("ESC"),
                  ),
              ),
          )
      .child(
        v_flex()
          .id("hotkeys-scroll-area")
          .flex_1()
          .min_h(0)
          .gap(8)
          .overflow_y_scrollbar()
          .children(
            HOTKEY_CATEGORIES.map((cat, catIdx) =>
              v_flex()
                .id(`hotkey-cat-${catIdx}`)
                .p(6)
                .gap(5)
                .bg("#14141e")
                .border_1()
                .border_color("#262637")
                .child(
                  h_flex()
                    .px(8)
                    .py(3)
                    .bg("#1e1e2e")
                    .border_1()
                    .border_color("#313244")
                    .items_center()
                    .child(
                      div()
                        .font_bold()
                        .font_family(MONO)
                        .text_size(10)
                        .text_color("#89b4fa")
                        .child(`■ ${cat.category.toUpperCase()} ■`),
                    ),
                )
                .child(
                  v_flex()
                    .gap(3)
                    .children(
                      cat.items.map((item, itemIdx) => {
                        const boundChords = item.customKeys ?? bindingsMap.get(item.action) ?? [];

                        return h_flex()
                          .id(`hotkey-row-${catIdx}-${itemIdx}`)
                          .px(8)
                          .py(4)
                          .bg("#181825")
                          .border_1()
                          .border_color("#262637")
                          .items_center()
                          .justify_between()
                          .hover((s) => s.bg("#222334").border_color("#3b3e5b"))
                          .child(
                            v_flex()
                              .flex_1()
                              .min_w(0)
                              .gap(1)
                              .child(
                                div()
                                  .font_family(MONO)
                                  .text_size(11)
                                  .font_bold()
                                  .text_color("#cdd6f4")
                                  .child(item.name),
                              )
                              .child(
                                div()
                                  .font_family(MONO)
                                  .text_size(9)
                                  .text_color("#6c7086")
                                  .child(item.desc),
                              ),
                          )
                          .child(
                            h_flex()
                              .gap(4)
                              .items_center()
                              .flex_wrap()
                              .children(
                                boundChords.length > 0
                                  ? boundChords.map((chord) =>
                                      div()
                                        .px(6)
                                        .py(1.5)
                                        .bg("#11111b")
                                        .border_1()
                                        .border_color("#45475a")
                                        .text_size(9)
                                        .font_bold()
                                        .font_family(MONO)
                                        .text_color("#89b4fa")
                                        .child(formatChord(chord)),
                                    )
                                  : [
                                      div()
                                        .font_family(MONO)
                                        .text_size(11)
                                        .text_color("#585b70")
                                        .child("—"),
                                    ],
                              ),
                          );
                      }),
                    ),
                ),
            ),
          ),
      )
          .child(
            h_flex()
              .h(24)
              .px(6)
              .items_center()
              .justify_between()
              .border_t(1)
              .border_color("#313244")
              .font_family(MONO)
              .text_size(9)
              .text_color("#6c7086")
              .child("TAHAN CTRL + TEKAN P BUAT GANTI LANTAI · ALT+[ / ALT+] PINDAH LANTAI")
              .child("ESC TUTUP"),
          ),
      );
  }
}
