// Popup alat bantu: cek Git per proyek, server dev, dan prompt tersimpan. Logikanya di tools.js.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, terminals, shared, setShared, run, exec, window, appHome, readTextFile, writeTextFile, closeOverlay } from "herdr";
import { parseDistros } from "./state.js";
import { teamKey } from "./team.js";
import {
  GIT_STATUS, GIT_UNPUSHED, GIT_REMOTES, GIT_FETCH, gitCommand, parseGitStatus, gitSummary,
  parseListeners, openUrlCommand, parsePrompts, cleanPrompt, MAX_PROMPTS,
} from "./tools.js";

export const PANEL_SIZE = { width: 460, height: 440 };
const TITLES = { git: "CEK GIT · PROYEK", servers: "SERVER DEV YANG NYALA", prompts: "PROMPT TERSIMPAN" };
const MONO = "JetBrains Mono";
const promptsFile = () => `${appHome()}/pixel-hq-prompts.json`;

const button = (id, text, color, tip, act) => div().id(id).flex_none().px(7).h(20).flex().items_center().cursor_pointer().border_1().border_color(`${color}88`).bg(`${color}22`)
  .text_size(10).font_bold().text_color(color).tooltip(tip).on_click(act).child(text);

export class Panels {
  // `props`: { panel: "git"|"servers"|"prompts", target?: terminal tujuan prompt, targetName?, overlay }
  // `projects`: fungsi async yang mengembalikan daftar proyek (tim + yang lagi aktif)
  constructor(props, projects, cx) {
    this.props = props;
    this.kind = props.panel;
    this.projects = projects;
    this.rows = null;
    this.busy = false;
    this.message = null;
    if (this.kind === "prompts") {
      this.input = InputState.new({ placeholder: "Tulis prompt baru, lalu Enter" });
      this.input.on("submit", (_e, cx) => this.addPrompt(cx));
    }
    cx.spawn(async (cx) => { await this.load(cx, false); });
  }

  async load(cx, fetch) {
    if (this.busy) return;
    this.busy = true;
    this.message = null;
    cx.notify();
    try {
      if (this.kind === "git") await this.loadGit(cx, fetch);
      else if (this.kind === "servers") await this.loadServers();
      else {
        const list = parsePrompts(await readTextFile(promptsFile()).catch(() => null));
        if (!list) this.message = "pixel-hq-prompts.json rusak, jadi gak saya timpa. Perbaiki atau hapus filenya.";
        this.rows = list;
      }
    } catch (e) { this.message = String(e?.message ?? e).slice(0, 200); }
    this.busy = false;
    cx.notify();
  }

  async loadGit(cx, fetch) {
    const platform = window().platform;
    const call = async (entry, args, timeout) => {
      const [cmd, argv] = gitCommand(entry, args, platform);
      return exec(cmd, argv, { timeout }).catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));
    };
    const check = async (entry) => {
      let fetchFailed = false;
      if (fetch) fetchFailed = (await call(entry, GIT_FETCH, 30000)).code !== 0;
      const st = await call(entry, GIT_STATUS, 20000);
      if (st.code !== 0) return /not a git repository/i.test(st.stderr ?? "") ? null : { entry, error: "gak bisa dicek" };
      const s = parseGitStatus(st.stdout);
      const remotes = await call(entry, GIT_REMOTES, 10000), count = await call(entry, GIT_UNPUSHED, 20000);
      if (remotes.code !== 0 || count.code !== 0) return { entry, error: "gak bisa dicek" }; // jangan bilang "aman" kalau gak tahu
      return { entry, branch: s.branch, fetchFailed, ...gitSummary(s, Number(count.stdout.trim()) || 0, Boolean(remotes.stdout.trim())) };
    };
    const list = await this.projects();
    const out = [];
    for (let i = 0; i < list.length; i += 4) {
      out.push(...(await Promise.all(list.slice(i, i + 4).map(check))).filter(Boolean));
      this.rows = [...out].sort((a, b) => Number(Boolean(b.dirty || b.error)) - Number(Boolean(a.dirty || a.error)));
      cx.notify();
    }
    this.rows ??= [];
    this.checkedWithFetch = fetch;
  }

  async loadServers() {
    const windows = window().platform === "windows";
    let hosts = [null];
    if (windows) {
      // di Windows yang dicek cuma server di dalam WSL (distro yang lagi jalan)
      const r = await exec("wsl.exe", ["--list", "--running", "--quiet"], { timeout: 8000 });
      hosts = r.code === 0 ? parseDistros(r.stdout) : [];
    }
    const rows = [];
    for (const distro of hosts) {
      const at = (cmd, args) => (distro == null ? exec(cmd, args, { timeout: 8000 }) : exec("wsl.exe", ["-d", distro, "-e", cmd, ...args], { timeout: 8000 }));
      const r = await at("ss", ["-ltnpH"]);
      if (r.code !== 0) throw new Error(`perintah ss gagal${distro ? ` di ${distro}` : ""} (paket iproute2)`);
      for (const l of parseListeners(r.stdout)) {
        let cwd = null;
        if (l.pid) { const c = await at("readlink", [`/proc/${l.pid}/cwd`]).catch(() => null); if (c?.code === 0) cwd = c.stdout.trim() || null; }
        rows.push({ ...l, cwd, distro });
      }
    }
    // yang prosesnya kelihatan (punya sendiri) di atas
    this.rows = rows.sort((a, b) => Number(!a.pid) - Number(!b.pid) || a.port - b.port);
  }

  savePrompts(change, cx) {
    cx.spawn(async (cx) => {
      const raw = await readTextFile(promptsFile()).catch(() => null);
      const list = parsePrompts(raw);
      if (!list) return;
      const next = change(list).slice(0, MAX_PROMPTS);
      try { await writeTextFile(promptsFile(), JSON.stringify(next, null, 2), raw); this.rows = next; }
      catch { this.message = "Gagal nyimpen, coba lagi."; }
      cx.notify();
    });
  }

  addPrompt(cx) {
    const text = cleanPrompt(this.input.value());
    if (!text) return;
    if ((this.rows?.length ?? 0) >= MAX_PROMPTS) { this.message = `Maksimal ${MAX_PROMPTS} prompt.`; cx.notify(); return; }
    this.input.set_value("");
    this.savePrompts((list) => [...list.filter((x) => x !== text), text], cx);
  }

  // Tempel ke staf tujuan TANPA Enter. Penempelannya dikerjakan jendela utama (popup ini keburu ketutup).
  usePrompt(text, cx) {
    const a = agents().find((x) => x.address === this.props.target);
    if (!a) { this.message = "Staf tujuannya udah gak ada. Tutup, pilih staf, lalu buka lagi."; cx.notify(); return; }
    if (a.status === "blocked") { this.message = "Staf itu lagi nunggu jawaban. Jawab dulu, biar prompt gak masuk ke dialognya."; cx.notify(); return; }
    cx.write_to_clipboard(cleanPrompt(text));
    setShared("pixel-hq.paste", { target: a.address, at: Date.now() });
    run("company-agents.pastePrompt");
    closeOverlay(this.props.overlay);
  }

  copy(text, cx) {
    cx.write_to_clipboard(cleanPrompt(text));
    this.message = "Tersalin.";
    cx.notify();
  }

  render(t) {
    const note = (text, color) => div().px(6).text_size(10.5).text_color(color).child(text);
    const line = (key, title, titleColor, sub, subColor, actions) => h_flex().id(key).min_h(38).flex_none().px(8).py(3).gap(6).items_center().border_b(1).border_color("#313244")
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(11.5).font_bold().text_color(titleColor).child(title))
        .child(div().text_size(9.5).text_color(subColor).child(sub)))
      .children(actions);
    const rows = this.rows ?? [];
    let body = [], head = null, foot = null;
    if (this.kind === "git") {
      const dirty = rows.filter((r) => r.dirty).length;
      if (this.rows && !this.busy) head = note(dirty ? `${dirty} proyek masih ada yang belum aman buat pindah komputer.` : "Gak ada perubahan lokal yang ketinggalan.", dirty ? "#f9b84a" : "#a6e3a1");
      body = rows.map((r, i) => line(`git-${i}`, `${r.entry.folder}${r.branch ? ` · ${r.branch}` : ""}`, r.error || r.dirty ? "#f9b84a" : "#a6e3a1",
        r.error ?? `${r.text}${r.fetchFailed ? " · fetch gagal" : ""}`, t.dim, []));
      foot = h_flex().gap(6).items_center().px(6)
        .child(div().flex_1().min_w(0).text_size(9.5).text_color(t.muted).child(this.checkedWithFetch ? "Udah dibandingkan dengan remote barusan." : "Commit baru dari komputer lain baru ketahuan setelah FETCH."))
        .child(button("git-reload", "CEK ULANG", "#89b4fa", "Baca ulang status lokal", (_e, cx) => cx.spawn(async (cx) => this.load(cx, false))))
        .child(button("git-fetch", "FETCH + CEK", "#a6e3a1", "git fetch di tiap proyek (butuh internet), lalu cek lagi", (_e, cx) => cx.spawn(async (cx) => this.load(cx, true))));
    } else if (this.kind === "servers") {
      body = rows.map((r) => line(`srv-${r.distro ?? ""}-${r.port}`, `localhost:${r.port}`, r.pid ? "#89b4fa" : t.dim,
        r.pid ? `${r.name}${r.cwd ? ` · ${r.cwd}` : ""}` : "prosesnya gak kelihatan (mis. Docker atau milik root)", t.dim,
        [button(`srv-open-${r.distro ?? ""}-${r.port}`, "BUKA ↗", "#a6e3a1", "Buka di browser", (_e, cx) => cx.spawn(async (cx) => {
          const [cmd, argv] = openUrlCommand(r.port, window().platform);
          await exec(cmd, argv, { timeout: 8000 }).catch(() => { this.message = "Gagal buka browser."; });
          cx.notify();
        }))]));
      foot = h_flex().gap(6).items_center().px(6)
        .child(div().flex_1().min_w(0).text_size(9.5).text_color(t.muted).child(window().platform === "windows" ? "Yang didaftar cuma server di WSL. Gak semua port itu web." : "Gak semua port itu web."))
        .child(button("srv-reload", "CEK ULANG", "#89b4fa", "Baca ulang daftar port", (_e, cx) => cx.spawn(async (cx) => this.load(cx, false))));
    } else {
      const target = this.props.target;
      head = note(target ? `Ditempel ke ${this.props.targetName ?? target}, tanpa Enter. Isi clipboard bakal keganti.` : "Belum ada staf yang dipilih: klik meja staf dulu buat menempel. Sekarang cuma bisa disalin.", target ? "#a6adc8" : "#f9b84a");
      body = rows.map((text, i) => line(`prompt-${i}`, text, t.foreground, "", t.dim, [
        target ? button(`prompt-use-${i}`, "TEMPEL", "#a6e3a1", text, (_e, cx) => this.usePrompt(text, cx)) : null,
        button(`prompt-copy-${i}`, "SALIN", "#89b4fa", text, (_e, cx) => this.copy(text, cx)),
        button(`prompt-del-${i}`, "×", "#a6adc8", "Hapus prompt ini", (_e, cx) => this.savePrompts((list) => list.filter((x) => x !== text), cx)),
      ].filter(Boolean)));
      foot = h_flex().gap(6).items_center().px(6)
        .child(div().flex_1().min_w(0).h(24).border_1().border_color("#45475a").px(4).child(Input.new(this.input).h_full().w_full().text_size(11).font_family(MONO).text_color(t.foreground)))
        .child(button("prompt-add", "SIMPAN", "#a6e3a1", "Simpan prompt", (_e, cx) => this.addPrompt(cx)));
    }
    return v_flex().w(PANEL_SIZE.width).h(PANEL_SIZE.height).p(8).gap(6).bg("#181825").border_1().border_color("#45475a").font_family(MONO)
      .child(h_flex().px(6).justify_between().items_center()
        .child(div().text_size(11).font_bold().text_color("#f9e2af").child(TITLES[this.kind] ?? ""))
        .child(button("panel-close", "ESC", "#a6adc8", "Tutup", () => closeOverlay(this.props.overlay))))
      .when(Boolean(head), (el) => el.child(head))
      .when(Boolean(this.message), (el) => el.child(note(this.message, "#f9b84a")))
      .child(v_flex().id("panel-list").flex_1().min_h(0).overflow_y_scrollbar()
        .children(body)
        .when(this.busy, (el) => el.child(note("Lagi ngecek…", t.muted)))
        .when(!this.busy && body.length === 0 && !this.message, (el) => el.child(note(this.kind === "git" ? "Belum ada proyek Git di daftar tim." : this.kind === "servers" ? "Gak ada server yang nyala." : "Belum ada prompt.", t.muted))))
      .when(Boolean(foot), (el) => el.child(foot));
  }
}

// Proyek buat cek Git: daftar tim ditambah yang lagi aktif, tanpa dobel.
export function mergeProjects(saved, live) {
  const out = new Map();
  for (const e of [...live, ...saved]) if (!out.has(teamKey(e))) out.set(teamKey(e), e);
  return [...out.values()];
}
