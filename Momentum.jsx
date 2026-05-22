import { useState, useEffect, useRef, useCallback } from "react";

// ─── THEMES ───────────────────────────────────────────────────────────────────
const THEMES = {
  obsidian: {
    bg: "#0d0d0f", card: "#18181c", border: "#2a2a32", text: "#f0eff4",
    muted: "#7a7a8c", accent: "#f5c842", accent2: "#e8853d", surface: "#1e1e24",
    success: "#4ade80", danger: "#f87171", info: "#60a5fa", name: "Obsidian"
  },
  ivory: {
    bg: "#f5f0e8", card: "#fffdf7", border: "#e2d9c8", text: "#1a1a2e",
    muted: "#7a7060", accent: "#c0392b", accent2: "#e67e22", surface: "#eee8d8",
    success: "#16a34a", danger: "#dc2626", info: "#2563eb", name: "Ivory"
  },
  cyber: {
    bg: "#020510", card: "#080d1f", border: "#0f2040", text: "#e0f0ff",
    muted: "#4a6080", accent: "#00f5d4", accent2: "#7b2fff", surface: "#0a1228",
    success: "#00f5d4", danger: "#ff4d6d", info: "#7b2fff", name: "Cyber"
  }
};

const QUOTES = [
  "Small steps every day lead to massive results.",
  "Discipline is choosing between what you want now and what you want most.",
  "You don't rise to the level of your goals, you fall to the level of your systems.",
  "The secret of getting ahead is getting started.",
  "Progress, not perfection.",
  "Every action you take is a vote for the person you want to become.",
  "Motivation gets you going. Habit keeps you growing.",
  "Success is the sum of small efforts, repeated daily.",
  "Dream big. Start small. Act now.",
  "Your future self is watching you right now through your memories."
];

const HABIT_TEMPLATES = [
  { name: "Morning Water", category: "Health", icon: "💧" },
  { name: "Exercise 30 min", category: "Health", icon: "🏃" },
  { name: "Read 20 pages", category: "Learning", icon: "📚" },
  { name: "Meditate", category: "Mindfulness", icon: "🧘" },
  { name: "Sleep by 11pm", category: "Health", icon: "😴" },
  { name: "No Social Media", category: "Focus", icon: "📵" },
  { name: "Journaling", category: "Mindfulness", icon: "✍️" },
  { name: "Cold Shower", category: "Health", icon: "🚿" },
  { name: "Study 2 hours", category: "Learning", icon: "🎓" },
  { name: "Gratitude List", category: "Mindfulness", icon: "🙏" },
];

const CATEGORIES = ["Health", "Learning", "Mindfulness", "Focus", "Work", "Personal", "Finance", "Social"];

const BADGE_MILESTONES = [
  { days: 3, label: "Starter", icon: "🌱", color: "#4ade80" },
  { days: 7, label: "Weekly Warrior", icon: "⚡", color: "#f5c842" },
  { days: 14, label: "Two-Week Titan", icon: "🔥", color: "#e8853d" },
  { days: 21, label: "Habit Former", icon: "💪", color: "#60a5fa" },
  { days: 30, label: "Monthly Master", icon: "🏆", color: "#a78bfa" },
  { days: 50, label: "Half-Century", icon: "💎", color: "#34d399" },
  { days: 100, label: "Centurion", icon: "👑", color: "#f5c842" },
];

function getBadge(streak) {
  let badge = null;
  for (const b of BADGE_MILESTONES) {
    if (streak >= b.days) badge = b;
  }
  return badge;
}

function getToday() { return new Date().toISOString().split("T")[0]; }
function formatDate(d) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function getDaysInMonth(year, month) { return new Date(year, month + 1, 0).getDate(); }
function getFirstDayOfMonth(year, month) { return new Date(year, month, 1).getDay(); }

// ─── CONFETTI ──────────────────────────────────────────────────────────────────
function Confetti({ active, onDone }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const pieces = Array.from({ length: 120 }, () => ({
      x: Math.random() * canvas.width,
      y: -10 - Math.random() * 100,
      r: 4 + Math.random() * 6,
      d: 1 + Math.random() * 3,
      color: ["#f5c842","#e8853d","#4ade80","#60a5fa","#a78bfa","#f87171"][Math.floor(Math.random()*6)],
      tilt: Math.random() * 10 - 5,
      tiltSpeed: 0.1 + Math.random() * 0.3,
      angle: 0
    }));
    let frame;
    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      pieces.forEach(p => {
        p.y += p.d; p.angle += p.tiltSpeed; p.tilt = Math.sin(p.angle) * 12;
        ctx.beginPath(); ctx.lineWidth = p.r;
        ctx.strokeStyle = p.color;
        ctx.moveTo(p.x + p.tilt, p.y);
        ctx.lineTo(p.x + p.tilt + p.r * 2, p.y + p.r * 2);
        ctx.stroke();
      });
      if (pieces.some(p => p.y < canvas.height)) frame = requestAnimationFrame(draw);
      else { ctx.clearRect(0, 0, canvas.width, canvas.height); onDone?.(); }
    }
    draw();
    return () => cancelAnimationFrame(frame);
  }, [active]);
  if (!active) return null;
  return <canvas ref={canvasRef} style={{ position: "fixed", top: 0, left: 0, pointerEvents: "none", zIndex: 9999 }} />;
}

// ─── POMODORO ──────────────────────────────────────────────────────────────────
function PomodoroModal({ t, onClose }) {
  const [mode, setMode] = useState("work");
  const [seconds, setSeconds] = useState(25 * 60);
  const [running, setRunning] = useState(false);
  const [sessions, setSessions] = useState(0);
  const intervalRef = useRef(null);
  const MODES = { work: 25 * 60, short: 5 * 60, long: 15 * 60 };

  useEffect(() => {
    if (running) {
      intervalRef.current = setInterval(() => {
        setSeconds(s => {
          if (s <= 1) { clearInterval(intervalRef.current); setRunning(false); setSessions(x => x + 1); return 0; }
          return s - 1;
        });
      }, 1000);
    } else clearInterval(intervalRef.current);
    return () => clearInterval(intervalRef.current);
  }, [running]);

  function switchMode(m) { setMode(m); setSeconds(MODES[m]); setRunning(false); }
  const pct = ((MODES[mode] - seconds) / MODES[mode]) * 100;
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  const r = 80, circ = 2 * Math.PI * r;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
      <div style={{ background: t.card, border: `1px solid ${t.border}`, borderRadius: 24, padding: 40, minWidth: 340, textAlign: "center" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <span style={{ fontSize: 20, fontWeight: 700, color: t.text }}>🍅 Pomodoro</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: t.muted, cursor: "pointer", fontSize: 20 }}>✕</button>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 28 }}>
          {[["work","Focus"],["short","Short Break"],["long","Long Break"]].map(([m,l]) => (
            <button key={m} onClick={() => switchMode(m)} style={{ padding: "6px 14px", borderRadius: 20, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, background: mode===m ? t.accent : t.surface, color: mode===m ? "#000" : t.muted }}>{l}</button>
          ))}
        </div>
        <div style={{ position: "relative", display: "inline-block", marginBottom: 28 }}>
          <svg width={200} height={200} style={{ transform: "rotate(-90deg)" }}>
            <circle cx={100} cy={100} r={r} fill="none" stroke={t.border} strokeWidth={10} />
            <circle cx={100} cy={100} r={r} fill="none" stroke={t.accent} strokeWidth={10}
              strokeDasharray={circ} strokeDashoffset={circ - (pct/100)*circ} strokeLinecap="round"
              style={{ transition: "stroke-dashoffset 0.5s" }} />
          </svg>
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontSize: 40, fontWeight: 800, color: t.text, letterSpacing: -2 }}>{mm}:{ss}</span>
            <span style={{ fontSize: 12, color: t.muted, textTransform: "uppercase", letterSpacing: 2 }}>{mode}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 12, justifyContent: "center", marginBottom: 16 }}>
          <button onClick={() => setRunning(r => !r)} style={{ padding: "12px 32px", borderRadius: 12, border: "none", cursor: "pointer", background: t.accent, color: "#000", fontWeight: 700, fontSize: 16 }}>{running ? "Pause" : "Start"}</button>
          <button onClick={() => { setSeconds(MODES[mode]); setRunning(false); }} style={{ padding: "12px 20px", borderRadius: 12, border: `1px solid ${t.border}`, cursor: "pointer", background: "none", color: t.text, fontWeight: 600 }}>Reset</button>
        </div>
        <div style={{ color: t.muted, fontSize: 14 }}>Sessions today: <strong style={{ color: t.accent }}>{sessions}</strong></div>
      </div>
    </div>
  );
}

// ─── CALENDAR MODAL ────────────────────────────────────────────────────────────
function CalendarModal({ t, habits, goals, onClose }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const days = getDaysInMonth(year, month);
  const firstDay = getFirstDayOfMonth(year, month);
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const today = getToday();

  function getDateStr(d) {
    return `${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  }

  function habitsDoneOn(dateStr) {
    return habits.filter(h => h.log && h.log[dateStr]).length;
  }
  function goalsDeadlineOn(dateStr) {
    return goals.filter(g => g.deadline === dateStr);
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
      <div style={{ background: t.card, border: `1px solid ${t.border}`, borderRadius: 24, padding: 32, width: "min(520px, 95vw)", maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <span style={{ fontSize: 20, fontWeight: 700, color: t.text }}>📅 Calendar View</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: t.muted, cursor: "pointer", fontSize: 20 }}>✕</button>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <button onClick={() => { if (month===0) { setMonth(11); setYear(y=>y-1); } else setMonth(m=>m-1); }} style={{ background: t.surface, border: "none", color: t.text, borderRadius: 8, padding: "6px 14px", cursor: "pointer", fontSize: 18 }}>‹</button>
          <span style={{ fontWeight: 700, fontSize: 18, color: t.text }}>{monthNames[month]} {year}</span>
          <button onClick={() => { if (month===11) { setMonth(0); setYear(y=>y+1); } else setMonth(m=>m+1); }} style={{ background: t.surface, border: "none", color: t.text, borderRadius: 8, padding: "6px 14px", cursor: "pointer", fontSize: 18 }}>›</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4, marginBottom: 8 }}>
          {["S","M","T","W","T","F","S"].map((d,i) => <div key={i} style={{ textAlign: "center", fontSize: 11, fontWeight: 700, color: t.muted, padding: "4px 0" }}>{d}</div>)}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4 }}>
          {Array.from({length: firstDay}).map((_,i) => <div key={`e${i}`} />)}
          {Array.from({length: days}).map((_,i) => {
            const d = i + 1;
            const dateStr = getDateStr(d);
            const habDone = habitsDoneOn(dateStr);
            const gDeadlines = goalsDeadlineOn(dateStr);
            const isToday = dateStr === today;
            const intensity = habits.length > 0 ? habDone / habits.length : 0;
            return (
              <div key={d} style={{ borderRadius: 8, padding: "6px 2px", textAlign: "center", position: "relative", background: isToday ? t.accent + "30" : intensity > 0 ? t.success + Math.floor(intensity*180).toString(16).padStart(2,"0") : t.surface, border: isToday ? `2px solid ${t.accent}` : `1px solid ${t.border}`, minHeight: 44 }}>
                <div style={{ fontSize: 12, fontWeight: isToday ? 800 : 500, color: isToday ? t.accent : t.text }}>{d}</div>
                {habDone > 0 && <div style={{ fontSize: 9, color: t.success, fontWeight: 700 }}>{habDone}✓</div>}
                {gDeadlines.map(g => <div key={g.id} style={{ fontSize: 8, background: t.danger+"44", color: t.danger, borderRadius: 2, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>📌</div>)}
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 16, marginTop: 20, fontSize: 12, color: t.muted }}>
          <span>🟩 Habits done</span><span>📌 Goal deadline</span><span style={{ color: t.accent }}>Today</span>
        </div>
      </div>
    </div>
  );
}

// ─── HEATMAP ───────────────────────────────────────────────────────────────────
function Heatmap({ t, habit }) {
  const today = new Date();
  const days = [];
  for (let i = 89; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().split("T")[0]);
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 8 }}>
      {days.map(d => (
        <div key={d} title={d} style={{ width: 10, height: 10, borderRadius: 2, background: habit.log?.[d] ? t.success : t.surface, border: `1px solid ${t.border}`, flexShrink: 0 }} />
      ))}
    </div>
  );
}

// ─── JOURNAL MODAL ─────────────────────────────────────────────────────────────
function JournalModal({ t, journals, setJournals, onClose }) {
  const today = getToday();
  const [note, setNote] = useState(journals[today] || "");
  const [selDate, setSelDate] = useState(today);

  function save() { setJournals(prev => ({ ...prev, [selDate]: note })); }

  const entries = Object.entries(journals).sort((a,b) => b[0].localeCompare(a[0]));

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
      <div style={{ background: t.card, border: `1px solid ${t.border}`, borderRadius: 24, padding: 32, width: "min(560px, 95vw)", maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <span style={{ fontSize: 20, fontWeight: 700, color: t.text }}>📓 Daily Journal</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: t.muted, cursor: "pointer", fontSize: 20 }}>✕</button>
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 12, color: t.muted, display: "block", marginBottom: 6 }}>Date</label>
          <input type="date" value={selDate} onChange={e => { setSelDate(e.target.value); setNote(journals[e.target.value] || ""); }}
            style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 8, padding: "8px 12px", color: t.text, fontSize: 14, width: "100%" }} />
        </div>
        <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="What did you do today? How do you feel? What are you grateful for?"
          style={{ width: "100%", height: 140, background: t.surface, border: `1px solid ${t.border}`, borderRadius: 12, padding: 14, color: t.text, fontSize: 14, resize: "vertical", boxSizing: "border-box" }} />
        <button onClick={save} style={{ width: "100%", padding: "12px", borderRadius: 12, border: "none", background: t.accent, color: "#000", fontWeight: 700, cursor: "pointer", marginTop: 12, marginBottom: 24 }}>Save Entry ✓</button>
        <div style={{ borderTop: `1px solid ${t.border}`, paddingTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: t.muted, marginBottom: 12 }}>Past Entries</div>
          {entries.length === 0 && <div style={{ color: t.muted, fontSize: 13 }}>No entries yet.</div>}
          {entries.map(([date, txt]) => (
            <div key={date} onClick={() => { setSelDate(date); setNote(txt); }} style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 10, padding: "10px 14px", marginBottom: 8, cursor: "pointer" }}>
              <div style={{ fontSize: 12, color: t.accent, fontWeight: 700, marginBottom: 4 }}>{formatDate(date)}</div>
              <div style={{ fontSize: 13, color: t.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{txt}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── AI COACH MODAL ────────────────────────────────────────────────────────────
function AICoachModal({ t, habits, goals, journals, onClose }) {
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState("");

  async function getInsights() {
    setLoading(true); setResponse("");
    const today = getToday();
    const habitSummary = habits.map(h => `- ${h.name}: streak ${h.streak} days, done today: ${h.log?.[today] ? "yes" : "no"}`).join("\n");
    const goalSummary = goals.map(g => {
      const done = g.actions.filter(a => a.done).length;
      return `- ${g.title}: ${done}/${g.actions.length} actions done, priority: ${g.priority}`;
    }).join("\n");
    const journalEntry = journals[today] || "No entry today.";

    const prompt = `You are an encouraging productivity coach. Here is my tracker data:

HABITS:
${habitSummary || "No habits tracked yet."}

GOALS:
${goalSummary || "No goals set yet."}

TODAY'S JOURNAL:
${journalEntry}

Give me:
1. A brief analysis of my progress (2-3 sentences)
2. What I'm doing well (1-2 things)
3. What to focus on this week (2-3 actionable tips)
4. A motivational closing message

Keep it warm, specific, and encouraging. Use emojis.`;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, messages: [{ role: "user", content: prompt }] })
      });
      const data = await res.json();
      setResponse(data.content?.[0]?.text || "Could not get response.");
    } catch { setResponse("Error connecting to AI. Please try again."); }
    setLoading(false);
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
      <div style={{ background: t.card, border: `1px solid ${t.border}`, borderRadius: 24, padding: 32, width: "min(560px, 95vw)", maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontSize: 20, fontWeight: 700, color: t.text }}>🤖 AI Coach</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: t.muted, cursor: "pointer", fontSize: 20 }}>✕</button>
        </div>
        <p style={{ color: t.muted, fontSize: 13, marginBottom: 24 }}>Get personalized weekly insights based on your habits, goals, and journal.</p>
        {!response && !loading && (
          <button onClick={getInsights} style={{ width: "100%", padding: "14px", borderRadius: 12, border: "none", background: t.accent, color: "#000", fontWeight: 700, cursor: "pointer", fontSize: 16 }}>✨ Get My Weekly Insights</button>
        )}
        {loading && (
          <div style={{ textAlign: "center", padding: 40 }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>🧠</div>
            <div style={{ color: t.muted }}>Analyzing your progress...</div>
          </div>
        )}
        {response && (
          <>
            <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 16, padding: 20, lineHeight: 1.7, color: t.text, fontSize: 14, whiteSpace: "pre-wrap" }}>{response}</div>
            <button onClick={getInsights} style={{ width: "100%", padding: "12px", borderRadius: 12, border: `1px solid ${t.border}`, background: "none", color: t.text, fontWeight: 600, cursor: "pointer", marginTop: 12 }}>🔄 Refresh Insights</button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── MAIN APP ──────────────────────────────────────────────────────────────────
export default function Momentum() {
  const [themeKey, setThemeKey] = useState(() => {
    const saved = localStorage.getItem("hg_theme");
    return (saved && THEMES[saved]) ? saved : "obsidian";
  });
  const [habits, setHabits] = useState(() => JSON.parse(localStorage.getItem("hg_habits") || "[]"));
  const [goals, setGoals] = useState(() => JSON.parse(localStorage.getItem("hg_goals") || "[]"));
  const [journals, setJournals] = useState(() => JSON.parse(localStorage.getItem("hg_journals") || "{}"));
  const [page, setPage] = useState("dashboard");
  const [confetti, setConfetti] = useState(false);
  const [toast, setToast] = useState(null);
  const [modal, setModal] = useState(null); // "pomodoro"|"calendar"|"journal"|"ai"|"badges"

  // Habits page state
  const [newHabit, setNewHabit] = useState({ name: "", category: "Health", icon: "⭐" });
  const [showTemplates, setShowTemplates] = useState(false);
  const [expandedHabit, setExpandedHabit] = useState(null);

  // Goals page state
  const [newGoal, setNewGoal] = useState({ title: "", priority: "Medium", deadline: "", notes: "" });
  const [newAction, setNewAction] = useState({ goalId: null, action: "", result: "" });
  const [bulkText, setBulkText] = useState("");
  const [expandedGoal, setExpandedGoal] = useState(null);
  const [showBulk, setShowBulk] = useState(false);
  const [showGoalForm, setShowGoalForm] = useState(false);

  const t = THEMES[themeKey] || THEMES.obsidian;
  const today = getToday();
  const quote = QUOTES[new Date().getDate() % QUOTES.length];

  // Persist
  useEffect(() => { localStorage.setItem("hg_habits", JSON.stringify(habits)); }, [habits]);
  useEffect(() => { localStorage.setItem("hg_goals", JSON.stringify(goals)); }, [goals]);
  useEffect(() => { localStorage.setItem("hg_journals", JSON.stringify(journals)); }, [journals]);
  useEffect(() => { localStorage.setItem("hg_theme", themeKey); }, [themeKey]);

  function showToast(msg, type="success") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2800);
  }

  // ─── HABIT LOGIC ──────────────────────────────────────────────────────────────
  function addHabit() {
    if (!newHabit.name.trim()) return;
    setHabits(prev => [...prev, { id: Date.now(), name: newHabit.name.trim(), category: newHabit.category, icon: newHabit.icon, streak: 0, bestStreak: 0, log: {} }]);
    setNewHabit({ name: "", category: "Health", icon: "⭐" });
    showToast("Habit added!");
  }

  function toggleHabit(id) {
    setHabits(prev => prev.map(h => {
      if (h.id !== id) return h;
      const log = { ...h.log };
      const wasChecked = !!log[today];
      if (wasChecked) { delete log[today]; }
      else { log[today] = true; }
      // Recalc streak
      let streak = 0, best = h.bestStreak || 0;
      const d = new Date();
      while (true) {
        const s = d.toISOString().split("T")[0];
        if (!log[s]) break;
        streak++; d.setDate(d.getDate() - 1);
      }
      if (streak > best) best = streak;
      // Confetti on milestones
      if (!wasChecked && BADGE_MILESTONES.some(b => b.days === streak)) {
        setConfetti(true); showToast(`🏆 ${streak}-day streak badge unlocked!`, "badge");
      }
      return { ...h, log, streak, bestStreak: best };
    }));
  }

  function deleteHabit(id) { setHabits(prev => prev.filter(h => h.id !== id)); }

  function addFromTemplate(tpl) {
    setHabits(prev => [...prev, { id: Date.now(), name: tpl.name, category: tpl.category, icon: tpl.icon, streak: 0, bestStreak: 0, log: {} }]);
    showToast(`Added "${tpl.name}"!`);
  }

  // ─── GOAL LOGIC ───────────────────────────────────────────────────────────────
  function addGoal() {
    if (!newGoal.title.trim()) return;
    setGoals(prev => [...prev, { id: Date.now(), ...newGoal, actions: [], createdAt: today }]);
    setNewGoal({ title: "", priority: "Medium", deadline: "", notes: "" });
    setShowGoalForm(false);
    showToast("Goal added!");
  }

  function addAction(goalId) {
    if (!newAction.action.trim()) return;
    setGoals(prev => prev.map(g => g.id !== goalId ? g : { ...g, actions: [...g.actions, { id: Date.now(), action: newAction.action, result: newAction.result, done: false, doneAt: null }] }));
    setNewAction({ goalId: null, action: "", result: "" });
  }

  function toggleAction(goalId, actionId) {
    setGoals(prev => prev.map(g => {
      if (g.id !== goalId) return g;
      const actions = g.actions.map(a => a.id !== actionId ? a : { ...a, done: !a.done, doneAt: !a.done ? today : null });
      const allDone = actions.length > 0 && actions.every(a => a.done);
      if (allDone) { setConfetti(true); showToast("🎯 Goal completed! Amazing!", "badge"); }
      return { ...g, actions };
    }));
  }

  function deleteGoal(id) { setGoals(prev => prev.filter(g => g.id !== id)); }

  function bulkUpload(goalId) {
    const lines = bulkText.trim().split("\n").filter(l => l.trim());
    const newActions = lines.map(l => {
      const [action, result=""] = l.split("|").map(s => s.trim());
      return { id: Date.now() + Math.random(), action, result, done: false, doneAt: null };
    });
    setGoals(prev => prev.map(g => g.id !== goalId ? g : { ...g, actions: [...g.actions, ...newActions] }));
    setBulkText(""); setShowBulk(false);
    showToast(`${newActions.length} actions added!`);
  }

  // ─── ANALYTICS DATA ──────────────────────────────────────────────────────────
  const totalHabits = habits.length;
  const doneToday = habits.filter(h => h.log?.[today]).length;
  const todayPct = totalHabits > 0 ? Math.round((doneToday / totalHabits) * 100) : 0;
  const totalGoals = goals.length;
  const completedGoals = goals.filter(g => g.actions.length > 0 && g.actions.every(a => a.done)).length;
  const totalActions = goals.reduce((s, g) => s + g.actions.length, 0);
  const doneActions = goals.reduce((s, g) => s + g.actions.filter(a => a.done).length, 0);
  const overallGoalPct = totalActions > 0 ? Math.round((doneActions / totalActions) * 100) : 0;

  // ─── RING SVG ─────────────────────────────────────────────────────────────────
  function Ring({ pct, size = 80, stroke = 8, color, label, sub }) {
    const r = (size - stroke) / 2;
    const circ = 2 * Math.PI * r;
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div style={{ position: "relative", width: size, height: size }}>
          <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
            <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={t.border} strokeWidth={stroke} />
            <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={stroke}
              strokeDasharray={circ} strokeDashoffset={circ - (pct/100)*circ} strokeLinecap="round"
              style={{ transition: "stroke-dashoffset 0.6s ease" }} />
          </svg>
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontSize: size > 70 ? 18 : 13, fontWeight: 800, color: t.text }}>{pct}%</span>
          </div>
        </div>
        {label && <span style={{ fontSize: 12, color: t.muted, marginTop: 6, textAlign: "center" }}>{label}</span>}
        {sub && <span style={{ fontSize: 11, color: color, fontWeight: 700 }}>{sub}</span>}
      </div>
    );
  }

  // ─── SIDEBAR ──────────────────────────────────────────────────────────────────
  const navItems = [
    { id: "dashboard", icon: "⚡", label: "Dashboard" },
    { id: "habits", icon: "🔥", label: "Habits" },
    { id: "goals", icon: "🎯", label: "Goals" },
    { id: "analytics", icon: "📊", label: "Analytics" },
  ];

  // ─── RENDER ───────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: "flex", minHeight: "100vh", background: t.bg, fontFamily: "'Sora', 'DM Sans', system-ui, sans-serif", color: t.text, position: "relative", flexDirection: "row" }}>
      <link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;600;700;800&display=swap" rel="stylesheet" />
      <style>{`
        @keyframes slideIn { from { transform: translateX(60px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        * { box-sizing: border-box; }
        .sidebar { display: flex; }
        .bottom-nav { display: none; }
        .main-content { padding: 32px 28px; }
        @media (max-width: 639px) {
          .sidebar { display: none !important; }
          .bottom-nav { display: flex !important; }
          .main-content { padding: 16px 14px 100px 14px !important; max-width: 100% !important; }
        }
      `}</style>

      {/* Toast */}
      {toast && (
        <div style={{ position: "fixed", top: 20, right: 20, zIndex: 9998, background: toast.type === "badge" ? t.accent : t.success, color: "#000", padding: "12px 20px", borderRadius: 12, fontWeight: 700, fontSize: 14, boxShadow: "0 8px 32px rgba(0,0,0,0.3)", animation: "slideIn 0.3s ease" }}>
          {toast.msg}
        </div>
      )}


      <Confetti active={confetti} onDone={() => setConfetti(false)} />

      {/* Modals */}
      {modal === "pomodoro" && <PomodoroModal t={t} onClose={() => setModal(null)} />}
      {modal === "calendar" && <CalendarModal t={t} habits={habits} goals={goals} onClose={() => setModal(null)} />}
      {modal === "journal" && <JournalModal t={t} journals={journals} setJournals={j => { setJournals(j); localStorage.setItem("hg_journals", JSON.stringify(j)); }} onClose={() => setModal(null)} />}
      {modal === "ai" && <AICoachModal t={t} habits={habits} goals={goals} journals={journals} onClose={() => setModal(null)} />}

      {/* Sidebar - hidden on mobile */}
      <div className="sidebar" style={{ width: 220, background: t.card, borderRight: `1px solid ${t.border}`, flexDirection: "column", padding: "24px 16px", position: "sticky", top: 0, height: "100vh", flexShrink: 0, overflowY: "auto" }}>
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: -1, color: t.accent }}>⚡ Momentum</div>
          <div style={{ fontSize: 11, color: t.muted, marginTop: 2 }}>Habit & Goal Tracker</div>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1 }}>
          {navItems.map(item => (
            <button key={item.id} onClick={() => setPage(item.id)} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 14px", borderRadius: 10, border: "none", cursor: "pointer", background: page === item.id ? t.accent + "22" : "none", color: page === item.id ? t.accent : t.muted, fontWeight: page === item.id ? 700 : 500, fontSize: 14, marginBottom: 4, transition: "all 0.15s", textAlign: "left" }}>
              <span>{item.icon}</span>{item.label}
            </button>
          ))}

          <div style={{ height: 1, background: t.border, margin: "16px 0" }} />

          {/* Quick Tools */}
          <div style={{ fontSize: 10, fontWeight: 700, color: t.muted, marginBottom: 8, letterSpacing: 1, textTransform: "uppercase" }}>Tools</div>
          {[["🍅","Pomodoro","pomodoro"],["📅","Calendar","calendar"],["📓","Journal","journal"],["🤖","AI Coach","ai"]].map(([icon,label,id]) => (
            <button key={id} onClick={() => setModal(id)} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 14px", borderRadius: 10, border: "none", cursor: "pointer", background: "none", color: t.muted, fontSize: 13, marginBottom: 4, textAlign: "left" }}>
              <span>{icon}</span>{label}
            </button>
          ))}
        </nav>

        {/* Theme */}
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: t.muted, marginBottom: 8, letterSpacing: 1, textTransform: "uppercase" }}>Theme</div>
          <div style={{ display: "flex", gap: 8 }}>
            {Object.entries(THEMES).map(([key, th]) => (
              <button key={key} onClick={() => setThemeKey(key)} title={th.name} style={{ width: 26, height: 26, borderRadius: "50%", border: themeKey === key ? `2px solid ${t.accent}` : "2px solid transparent", background: th.accent, cursor: "pointer", transition: "all 0.2s" }} />
            ))}
          </div>
          <div style={{ fontSize: 11, color: t.muted, marginTop: 6 }}>{t.name} Theme</div>
        </div>
      </div>

      {/* Main */}
      <div className="main-content" style={{ flex: 1, overflowY: "auto", maxWidth: 900 }}>

        {/* ── DASHBOARD ── */}
        {page === "dashboard" && (
          <div>
            <div style={{ marginBottom: 28 }}>
              <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0, letterSpacing: -1 }}>Good {new Date().getHours() < 12 ? "Morning" : new Date().getHours() < 17 ? "Afternoon" : "Evening"} 👋</h1>
              <p style={{ color: t.muted, margin: "4px 0 0", fontSize: 14 }}>{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p>
            </div>

            {/* Quote */}
            <div style={{ background: t.accent + "18", border: `1px solid ${t.accent}44`, borderRadius: 14, padding: "14px 18px", marginBottom: 28, borderLeft: `4px solid ${t.accent}` }}>
              <span style={{ fontSize: 13, color: t.text, fontStyle: "italic" }}>💬 "{quote}"</span>
            </div>

            {/* Stats row */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 16, marginBottom: 28 }}>
              {[
                { label: "Today's Habits", val: `${doneToday}/${totalHabits}`, sub: `${todayPct}% done`, color: t.accent },
                { label: "Active Goals", val: totalGoals, sub: `${completedGoals} completed`, color: t.info },
                { label: "Total Actions", val: `${doneActions}/${totalActions}`, sub: `${overallGoalPct}% done`, color: t.success },
                { label: "Journal Entries", val: Object.keys(journals).length, sub: "days logged", color: t.accent2 },
              ].map((s,i) => (
                <div key={i} style={{ background: t.card, border: `1px solid ${t.border}`, borderRadius: 14, padding: "18px 16px" }}>
                  <div style={{ fontSize: 24, fontWeight: 800, color: s.color }}>{s.val}</div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: t.text, margin: "4px 0 2px" }}>{s.label}</div>
                  <div style={{ fontSize: 11, color: t.muted }}>{s.sub}</div>
                </div>
              ))}
            </div>

            {/* Progress rings */}
            <div style={{ background: t.card, border: `1px solid ${t.border}`, borderRadius: 16, padding: 24, marginBottom: 24 }}>
              <h3 style={{ margin: "0 0 20px", fontSize: 16, fontWeight: 700 }}>Today's Progress</h3>
              <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
                <Ring pct={todayPct} color={t.accent} label="Habits Today" sub={`${doneToday}/${totalHabits}`} />
                <Ring pct={overallGoalPct} color={t.info} label="Goal Actions" sub={`${doneActions}/${totalActions}`} />
                <Ring pct={totalGoals > 0 ? Math.round((completedGoals/totalGoals)*100) : 0} color={t.success} label="Goals Done" sub={`${completedGoals}/${totalGoals}`} />
              </div>
            </div>

            {/* Today's habits quick check */}
            {habits.length > 0 && (
              <div style={{ background: t.card, border: `1px solid ${t.border}`, borderRadius: 16, padding: 24, marginBottom: 24 }}>
                <h3 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 700 }}>Quick Check-in</h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {habits.map(h => (
                    <div key={h.id} onClick={() => toggleHabit(h.id)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderRadius: 10, background: h.log?.[today] ? t.success + "18" : t.surface, border: `1px solid ${h.log?.[today] ? t.success + "44" : t.border}`, cursor: "pointer", transition: "all 0.15s" }}>
                      <div style={{ width: 20, height: 20, borderRadius: 6, border: `2px solid ${h.log?.[today] ? t.success : t.muted}`, background: h.log?.[today] ? t.success : "none", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        {h.log?.[today] && <span style={{ color: "#000", fontSize: 12, fontWeight: 800 }}>✓</span>}
                      </div>
                      <span style={{ fontSize: 14 }}>{h.icon} {h.name}</span>
                      {h.streak > 0 && <span style={{ marginLeft: "auto", fontSize: 11, color: t.accent, fontWeight: 700 }}>🔥 {h.streak}d</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* High priority goals */}
            {goals.filter(g => g.priority === "High").length > 0 && (
              <div style={{ background: t.card, border: `1px solid ${t.border}`, borderRadius: 16, padding: 24 }}>
                <h3 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 700 }}>🔴 High Priority Goals</h3>
                {goals.filter(g => g.priority === "High").map(g => {
                  const pct = g.actions.length > 0 ? Math.round((g.actions.filter(a => a.done).length / g.actions.length) * 100) : 0;
                  return (
                    <div key={g.id} style={{ marginBottom: 12 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                        <span style={{ fontSize: 14, fontWeight: 600 }}>{g.title}</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: t.accent }}>{pct}%</span>
                      </div>
                      <div style={{ height: 6, background: t.surface, borderRadius: 10 }}>
                        <div style={{ height: "100%", width: `${pct}%`, background: t.accent, borderRadius: 10, transition: "width 0.5s" }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── HABITS ── */}
        {page === "habits" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
              <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>🔥 Daily Habits</h1>
              <button onClick={() => setShowTemplates(!showTemplates)} style={{ padding: "8px 16px", borderRadius: 10, border: `1px solid ${t.border}`, background: t.surface, color: t.text, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>📋 Templates</button>
            </div>

            {/* Templates */}
            {showTemplates && (
              <div style={{ background: t.card, border: `1px solid ${t.border}`, borderRadius: 16, padding: 20, marginBottom: 24 }}>
                <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14, color: t.text }}>Quick Add Templates</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {HABIT_TEMPLATES.map((tpl, i) => (
                    <button key={i} onClick={() => addFromTemplate(tpl)} style={{ padding: "8px 14px", borderRadius: 20, border: `1px solid ${t.border}`, background: t.surface, color: t.text, cursor: "pointer", fontSize: 13 }}>
                      {tpl.icon} {tpl.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Add habit form */}
            <div style={{ background: t.card, border: `1px solid ${t.border}`, borderRadius: 16, padding: 20, marginBottom: 24 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>Add New Habit</div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <input value={newHabit.icon} onChange={e => setNewHabit(p => ({...p, icon: e.target.value}))} style={{ width: 50, padding: "10px", borderRadius: 10, border: `1px solid ${t.border}`, background: t.surface, color: t.text, textAlign: "center", fontSize: 18 }} />
                <input value={newHabit.name} onChange={e => setNewHabit(p => ({...p, name: e.target.value}))} onKeyDown={e => e.key === "Enter" && addHabit()} placeholder="Habit name..." style={{ flex: 1, minWidth: 140, padding: "10px 14px", borderRadius: 10, border: `1px solid ${t.border}`, background: t.surface, color: t.text, fontSize: 14 }} />
                <select value={newHabit.category} onChange={e => setNewHabit(p => ({...p, category: e.target.value}))} style={{ padding: "10px 14px", borderRadius: 10, border: `1px solid ${t.border}`, background: t.surface, color: t.text, fontSize: 14 }}>
                  {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                </select>
                <button onClick={addHabit} style={{ padding: "10px 20px", borderRadius: 10, border: "none", background: t.accent, color: "#000", fontWeight: 700, cursor: "pointer" }}>+ Add</button>
              </div>
            </div>

            {/* Habit list */}
            {habits.length === 0 && <div style={{ textAlign: "center", color: t.muted, padding: 40, fontSize: 15 }}>No habits yet. Add one above or use templates! 🌱</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {habits.map(h => {
                const badge = getBadge(h.streak);
                const totalDone = Object.values(h.log || {}).filter(Boolean).length;
                const expanded = expandedHabit === h.id;
                return (
                  <div key={h.id} style={{ background: t.card, border: `1px solid ${t.border}`, borderRadius: 14, overflow: "hidden" }}>
                    <div style={{ padding: "14px 18px", display: "flex", alignItems: "center", gap: 12 }}>
                      <div onClick={() => toggleHabit(h.id)} style={{ width: 26, height: 26, borderRadius: 8, border: `2px solid ${h.log?.[today] ? t.success : t.border}`, background: h.log?.[today] ? t.success : "none", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0, transition: "all 0.2s" }}>
                        {h.log?.[today] && <span style={{ color: "#000", fontSize: 14, fontWeight: 900 }}>✓</span>}
                      </div>
                      <span style={{ fontSize: 20 }}>{h.icon}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 15, color: h.log?.[today] ? t.success : t.text }}>{h.name}</div>
                        <div style={{ fontSize: 11, color: t.muted }}>{h.category} · {totalDone} total completions</div>
                      </div>
                      {h.streak > 0 && <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: t.accent }}>🔥 {h.streak}d</span>
                        {badge && <span title={badge.label} style={{ fontSize: 16 }}>{badge.icon}</span>}
                      </div>}
                      <button onClick={() => setExpandedHabit(expanded ? null : h.id)} style={{ background: "none", border: "none", color: t.muted, cursor: "pointer", fontSize: 16 }}>{expanded ? "▲" : "▼"}</button>
                      <button onClick={() => deleteHabit(h.id)} style={{ background: "none", border: "none", color: t.danger, cursor: "pointer", fontSize: 16 }}>🗑</button>
                    </div>
                    {expanded && (
                      <div style={{ borderTop: `1px solid ${t.border}`, padding: "14px 18px", background: t.surface }}>
                        <div style={{ display: "flex", gap: 24, marginBottom: 14, flexWrap: "wrap" }}>
                          <div><div style={{ fontSize: 20, fontWeight: 800, color: t.accent }}>{h.streak}</div><div style={{ fontSize: 11, color: t.muted }}>Current Streak</div></div>
                          <div><div style={{ fontSize: 20, fontWeight: 800, color: t.info }}>{h.bestStreak || h.streak}</div><div style={{ fontSize: 11, color: t.muted }}>Best Streak</div></div>
                          <div><div style={{ fontSize: 20, fontWeight: 800, color: t.success }}>{totalDone}</div><div style={{ fontSize: 11, color: t.muted }}>Total Done</div></div>
                          {badge && <div><div style={{ fontSize: 20 }}>{badge.icon}</div><div style={{ fontSize: 11, color: t.muted }}>{badge.label}</div></div>}
                        </div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: t.muted, marginBottom: 8 }}>LAST 90 DAYS</div>
                        <Heatmap t={t} habit={h} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── GOALS ── */}
        {page === "goals" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
              <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>🎯 Goals</h1>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setShowGoalForm(!showGoalForm)} style={{ padding: "8px 16px", borderRadius: 10, border: "none", background: t.accent, color: "#000", cursor: "pointer", fontSize: 13, fontWeight: 700 }}>+ New Goal</button>
              </div>
            </div>

            {/* Add goal form */}
            {showGoalForm && (
              <div style={{ background: t.card, border: `1px solid ${t.border}`, borderRadius: 16, padding: 20, marginBottom: 24 }}>
                <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>New Goal</div>
                <input value={newGoal.title} onChange={e => setNewGoal(p => ({...p, title: e.target.value}))} placeholder="Goal title..." style={{ width: "100%", padding: "10px 14px", borderRadius: 10, border: `1px solid ${t.border}`, background: t.surface, color: t.text, fontSize: 14, marginBottom: 10, boxSizing: "border-box" }} />
                <div style={{ display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                  <select value={newGoal.priority} onChange={e => setNewGoal(p => ({...p, priority: e.target.value}))} style={{ flex: 1, padding: "10px 14px", borderRadius: 10, border: `1px solid ${t.border}`, background: t.surface, color: t.text }}>
                    {["High","Medium","Low"].map(p => <option key={p}>{p}</option>)}
                  </select>
                  <input type="date" value={newGoal.deadline} onChange={e => setNewGoal(p => ({...p, deadline: e.target.value}))} style={{ flex: 1, padding: "10px 14px", borderRadius: 10, border: `1px solid ${t.border}`, background: t.surface, color: t.text }} />
                </div>
                <textarea value={newGoal.notes} onChange={e => setNewGoal(p => ({...p, notes: e.target.value}))} placeholder="Notes / why this goal matters..." style={{ width: "100%", height: 70, padding: "10px 14px", borderRadius: 10, border: `1px solid ${t.border}`, background: t.surface, color: t.text, fontSize: 14, resize: "none", boxSizing: "border-box", marginBottom: 10 }} />
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={addGoal} style={{ padding: "10px 24px", borderRadius: 10, border: "none", background: t.accent, color: "#000", fontWeight: 700, cursor: "pointer" }}>Add Goal</button>
                  <button onClick={() => setShowGoalForm(false)} style={{ padding: "10px 16px", borderRadius: 10, border: `1px solid ${t.border}`, background: "none", color: t.text, cursor: "pointer" }}>Cancel</button>
                </div>
              </div>
            )}

            {goals.length === 0 && <div style={{ textAlign: "center", color: t.muted, padding: 40 }}>No goals yet. Create your first goal! 🚀</div>}

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {goals.map(g => {
                const done = g.actions.filter(a => a.done).length;
                const pct = g.actions.length > 0 ? Math.round((done / g.actions.length) * 100) : 0;
                const daysLeft = g.deadline ? Math.ceil((new Date(g.deadline) - new Date()) / 86400000) : null;
                const expanded = expandedGoal === g.id;
                const prioColor = g.priority === "High" ? t.danger : g.priority === "Medium" ? t.accent : t.success;

                return (
                  <div key={g.id} style={{ background: t.card, border: `1px solid ${t.border}`, borderRadius: 14, overflow: "hidden" }}>
                    <div style={{ padding: "16px 18px" }}>
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                            <span style={{ fontWeight: 700, fontSize: 16 }}>{g.title}</span>
                            <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: prioColor + "22", color: prioColor }}>{g.priority}</span>
                            {pct === 100 && <span style={{ fontSize: 16 }}>✅</span>}
                          </div>
                          {g.deadline && <div style={{ fontSize: 11, color: daysLeft < 3 ? t.danger : t.muted }}>📅 {daysLeft !== null ? (daysLeft < 0 ? "Overdue!" : daysLeft === 0 ? "Due today!" : `${daysLeft} days left`) : ""} ({formatDate(g.deadline)})</div>}
                          <div style={{ marginTop: 10 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: t.muted, marginBottom: 4 }}>
                              <span>{done}/{g.actions.length} actions</span><span style={{ fontWeight: 700, color: t.accent }}>{pct}%</span>
                            </div>
                            <div style={{ height: 6, background: t.surface, borderRadius: 10 }}>
                              <div style={{ height: "100%", width: `${pct}%`, background: pct === 100 ? t.success : t.accent, borderRadius: 10, transition: "width 0.5s" }} />
                            </div>
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 4 }}>
                          <button onClick={() => setExpandedGoal(expanded ? null : g.id)} style={{ background: t.surface, border: "none", color: t.muted, cursor: "pointer", borderRadius: 8, padding: "6px 10px", fontSize: 13 }}>{expanded ? "▲" : "▼"}</button>
                          <button onClick={() => deleteGoal(g.id)} style={{ background: "none", border: "none", color: t.danger, cursor: "pointer", fontSize: 16 }}>🗑</button>
                        </div>
                      </div>
                    </div>

                    {expanded && (
                      <div style={{ borderTop: `1px solid ${t.border}`, padding: "16px 18px", background: t.surface }}>
                        {g.notes && <div style={{ fontSize: 13, color: t.muted, fontStyle: "italic", marginBottom: 14, padding: "8px 12px", background: t.card, borderRadius: 8 }}>📝 {g.notes}</div>}

                        {/* Actions */}
                        <div style={{ marginBottom: 14 }}>
                          {g.actions.map(a => (
                            <div key={a.id} onClick={() => toggleAction(g.id, a.id)} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px", borderRadius: 10, marginBottom: 6, background: a.done ? t.success + "18" : t.card, border: `1px solid ${a.done ? t.success + "44" : t.border}`, cursor: "pointer" }}>
                              <div style={{ width: 18, height: 18, borderRadius: 5, border: `2px solid ${a.done ? t.success : t.muted}`, background: a.done ? t.success : "none", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
                                {a.done && <span style={{ color: "#000", fontSize: 11, fontWeight: 900 }}>✓</span>}
                              </div>
                              <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 14, color: a.done ? t.muted : t.text, textDecoration: a.done ? "line-through" : "none" }}>{a.action}</div>
                                {a.result && <div style={{ fontSize: 12, color: t.info, marginTop: 2 }}>→ {a.result}</div>}
                                {a.doneAt && <div style={{ fontSize: 10, color: t.muted, marginTop: 2 }}>Done {formatDate(a.doneAt)}</div>}
                              </div>
                            </div>
                          ))}
                        </div>

                        {/* Add action */}
                        <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                          <input value={newAction.goalId === g.id ? newAction.action : ""} onChange={e => setNewAction({ goalId: g.id, action: e.target.value, result: newAction.goalId === g.id ? newAction.result : "" })} placeholder="Action step..." style={{ flex: 1, minWidth: 120, padding: "8px 12px", borderRadius: 8, border: `1px solid ${t.border}`, background: t.card, color: t.text, fontSize: 13 }} />
                          <input value={newAction.goalId === g.id ? newAction.result : ""} onChange={e => setNewAction(p => ({...p, goalId: g.id, result: e.target.value}))} placeholder="Expected result..." style={{ flex: 1, minWidth: 120, padding: "8px 12px", borderRadius: 8, border: `1px solid ${t.border}`, background: t.card, color: t.text, fontSize: 13 }} />
                          <button onClick={() => addAction(g.id)} style={{ padding: "8px 14px", borderRadius: 8, border: "none", background: t.accent, color: "#000", fontWeight: 700, cursor: "pointer" }}>+</button>
                        </div>

                        {/* Bulk upload */}
                        <button onClick={() => setShowBulk(showBulk === g.id ? null : g.id)} style={{ fontSize: 12, color: t.info, background: "none", border: "none", cursor: "pointer", padding: 0, marginBottom: 8 }}>📋 Bulk upload actions</button>
                        {showBulk === g.id && (
                          <div>
                            <textarea value={bulkText} onChange={e => setBulkText(e.target.value)} placeholder={"ACTION | EXPECTED RESULT\nStudy Chapter 1 | Understand basics\nDo practice problems | Score 80%+"} style={{ width: "100%", height: 100, padding: "10px 12px", borderRadius: 8, border: `1px solid ${t.border}`, background: t.card, color: t.text, fontSize: 13, resize: "none", boxSizing: "border-box", marginBottom: 8 }} />
                            <button onClick={() => bulkUpload(g.id)} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: t.accent, color: "#000", fontWeight: 700, cursor: "pointer", fontSize: 13 }}>Upload Actions</button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── ANALYTICS ── */}
        {page === "analytics" && (
          <div>
            <h1 style={{ fontSize: 26, fontWeight: 800, margin: "0 0 24px" }}>📊 Analytics</h1>

            {/* Overview rings */}
            <div style={{ background: t.card, border: `1px solid ${t.border}`, borderRadius: 16, padding: 24, marginBottom: 24 }}>
              <h3 style={{ margin: "0 0 20px", fontSize: 15, fontWeight: 700 }}>Overall Progress</h3>
              <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
                <Ring pct={todayPct} size={100} stroke={10} color={t.accent} label="Today's Habits" sub={`${doneToday}/${totalHabits}`} />
                <Ring pct={overallGoalPct} size={100} stroke={10} color={t.info} label="Goal Completion" sub={`${doneActions}/${totalActions}`} />
                <Ring pct={totalGoals > 0 ? Math.round((completedGoals/totalGoals)*100) : 0} size={100} stroke={10} color={t.success} label="Goals Finished" sub={`${completedGoals}/${totalGoals}`} />
              </div>
            </div>

            {/* Habit streaks leaderboard */}
            {habits.length > 0 && (
              <div style={{ background: t.card, border: `1px solid ${t.border}`, borderRadius: 16, padding: 24, marginBottom: 24 }}>
                <h3 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 700 }}>🏆 Streak Leaderboard</h3>
                {[...habits].sort((a,b) => b.streak - a.streak).map((h, i) => {
                  const badge = getBadge(h.streak);
                  const total = Object.values(h.log || {}).filter(Boolean).length;
                  return (
                    <div key={h.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: `1px solid ${t.border}` }}>
                      <span style={{ fontSize: 16, fontWeight: 800, color: i===0 ? t.accent : i===1 ? t.muted : t.muted, width: 24, textAlign: "center" }}>{i+1}</span>
                      <span style={{ fontSize: 18 }}>{h.icon}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>{h.name}</div>
                        <div style={{ fontSize: 11, color: t.muted }}>{h.category} · {total} total done</div>
                      </div>
                      {badge && <span title={badge.label}>{badge.icon}</span>}
                      <span style={{ fontWeight: 700, color: t.accent }}>🔥 {h.streak}d</span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Goal-by-goal progress */}
            {goals.length > 0 && (
              <div style={{ background: t.card, border: `1px solid ${t.border}`, borderRadius: 16, padding: 24, marginBottom: 24 }}>
                <h3 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 700 }}>Goal Progress Breakdown</h3>
                {goals.map(g => {
                  const done = g.actions.filter(a => a.done).length;
                  const pct = g.actions.length > 0 ? Math.round((done/g.actions.length)*100) : 0;
                  const prioColor = g.priority === "High" ? t.danger : g.priority === "Medium" ? t.accent : t.success;
                  return (
                    <div key={g.id} style={{ marginBottom: 16 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                        <div>
                          <span style={{ fontWeight: 600, fontSize: 14 }}>{g.title}</span>
                          <span style={{ fontSize: 10, fontWeight: 700, marginLeft: 8, padding: "1px 6px", borderRadius: 10, background: prioColor + "22", color: prioColor }}>{g.priority}</span>
                        </div>
                        <span style={{ fontSize: 13, fontWeight: 700, color: pct===100 ? t.success : t.accent }}>{pct}%</span>
                      </div>
                      <div style={{ height: 8, background: t.surface, borderRadius: 10 }}>
                        <div style={{ height: "100%", width: `${pct}%`, background: pct===100 ? t.success : t.accent, borderRadius: 10, transition: "width 0.5s" }} />
                      </div>
                      <div style={{ fontSize: 11, color: t.muted, marginTop: 4 }}>{done}/{g.actions.length} actions complete</div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Badges earned */}
            <div style={{ background: t.card, border: `1px solid ${t.border}`, borderRadius: 16, padding: 24, marginBottom: 24 }}>
              <h3 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 700 }}>🏅 Badges Earned</h3>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                {BADGE_MILESTONES.map(b => {
                  const earned = habits.some(h => (h.bestStreak || h.streak) >= b.days);
                  return (
                    <div key={b.days} style={{ padding: "10px 16px", borderRadius: 12, background: earned ? b.color + "22" : t.surface, border: `1px solid ${earned ? b.color + "66" : t.border}`, textAlign: "center", opacity: earned ? 1 : 0.4 }}>
                      <div style={{ fontSize: 24 }}>{b.icon}</div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: earned ? b.color : t.muted, marginTop: 4 }}>{b.label}</div>
                      <div style={{ fontSize: 10, color: t.muted }}>{b.days}d streak</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Heatmaps */}
            {habits.map(h => (
              <div key={h.id} style={{ background: t.card, border: `1px solid ${t.border}`, borderRadius: 14, padding: 18, marginBottom: 12 }}>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>{h.icon} {h.name} — 90-Day Heatmap</div>
                <Heatmap t={t} habit={h} />
              </div>
            ))}

            {habits.length === 0 && goals.length === 0 && (
              <div style={{ textAlign: "center", color: t.muted, padding: 40 }}>Start tracking habits and goals to see analytics! 📈</div>
            )}
          </div>
        )}
      </div>

      {/* Bottom Nav - mobile only */}
      <div className="bottom-nav" style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: t.card, borderTop: `1px solid ${t.border}`, flexDirection: "column", zIndex: 500 }}>
        {/* Tools row */}
        <div style={{ display: "flex", justifyContent: "space-around", padding: "6px 0 2px", borderBottom: `1px solid ${t.border}` }}>
          {[["🍅","Pomodoro","pomodoro"],["📅","Calendar","calendar"],["📓","Journal","journal"],["🤖","AI Coach","ai"],
            ...Object.entries(THEMES).map(([key, th]) => [th.accent, th.name, `theme_${key}`])
          ].slice(0,6).map(([icon, label, id]) => {
            if (id.startsWith("theme_")) {
              const key = id.replace("theme_","");
              return (
                <button key={id} onClick={() => setThemeKey(key)} style={{ background: "none", border: "none", cursor: "pointer", padding: "4px 6px", display: "flex", flexDirection: "column", alignItems: "center" }}>
                  <div style={{ width: 18, height: 18, borderRadius: "50%", background: THEMES[key].accent, border: themeKey===key ? `2px solid ${t.text}` : "2px solid transparent" }} />
                  <span style={{ fontSize: 8, color: t.muted, marginTop: 2 }}>{label}</span>
                </button>
              );
            }
            return (
              <button key={id} onClick={() => setModal(id)} style={{ background: "none", border: "none", cursor: "pointer", padding: "4px 8px", display: "flex", flexDirection: "column", alignItems: "center" }}>
                <span style={{ fontSize: 18 }}>{icon}</span>
                <span style={{ fontSize: 8, color: t.muted, marginTop: 1 }}>{label}</span>
              </button>
            );
          })}
        </div>
        {/* Main nav */}
        <div style={{ display: "flex", justifyContent: "space-around", padding: "8px 0 10px" }}>
          {navItems.map(item => (
            <button key={item.id} onClick={() => setPage(item.id)} style={{ background: "none", border: "none", cursor: "pointer", padding: "4px 12px", display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
              <span style={{ fontSize: 22 }}>{item.icon}</span>
              <span style={{ fontSize: 10, fontWeight: page === item.id ? 700 : 400, color: page === item.id ? t.accent : t.muted }}>{item.label}</span>
              {page === item.id && <div style={{ width: 4, height: 4, borderRadius: "50%", background: t.accent }} />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
