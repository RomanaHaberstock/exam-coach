/*
 * Exam Coach: the demo experience. Loaded after app.js and uses its globals (S, commit, replan, …).
 * Nothing in this file calls the AI, so the example works when the AI is slow, out of quota or off.
 *
 * Sections: example history · example questions · example banner · guided tour · how it works · events
 */
"use strict";

/* ---------- example history ---------- */
// "Try it with example exams": the two example exams plus about two weeks of made-up history,
// so every page has something real to show: done blocks, quizzes and retention checks, one result
// below plan whose cause is a weak prerequisite (Random variables → Probability basics), a missed
// block, and the simulated learning profile. The quiz results go through the real feedback loop
// (quizEffect), so the log entries and plan changes are exactly what the coach would write.
// Each history item: [days ago, exam (0 Statistics, 1 Microeconomics), topic, kind, minutes];
// kind "learn", "repair", "check" (retention check, done), "missed" (a skipped learning block).
const DEMO_HISTORY = [
  [12, 0, "Descriptive statistics", "learn", 60],
  [11, 0, "Descriptive statistics", "learn", 60],
  [10, 0, "Probability basics", "learn", 60], [10, 1, "Supply & demand", "learn", 60],
  [9, 0, "Probability basics", "learn", 60], [9, 0, "Descriptive statistics", "check", 15], [9, 1, "Supply & demand", "learn", 60],
  [8, 0, "Probability basics", "learn", 60],
  [7, 0, "Probability basics", "learn", 60], [7, 1, "Supply & demand", "check", 15],
  [6, 0, "Probability basics", "repair", 30], [6, 0, "Probability basics", "learn", 60], [6, 0, "Random variables & distributions", "learn", 60],
  [5, 0, "Probability basics", "check", 15], [5, 0, "Random variables & distributions", "learn", 60], [5, 1, "Elasticities", "learn", 60],
  [4, 0, "Random variables & distributions", "learn", 60], [4, 1, "Elasticities", "missed", 60],
  [3, 0, "Random variables & distributions", "learn", 60], [3, 0, "Random variables & distributions", "learn", 60], [3, 1, "Elasticities", "learn", 60],
  [2, 0, "Normal distribution & CLT", "learn", 60], [2, 1, "Elasticities", "learn", 60],
  [1, 0, "Random variables & distributions", "check", 15], [1, 0, "Normal distribution & CLT", "learn", 60]
];
// Quiz results: [days ago, exam, topic, score, kind, concepts missed]. "immediate" = right after
// finishing a topic, "retention" = the 2-day retention check (the block above).
const DEMO_QUIZZES = [
  [11, 0, "Descriptive statistics", 84, "immediate", ["Box plots"]],
  [9, 0, "Descriptive statistics", 82, "retention", []],
  [9, 1, "Supply & demand", 92, "immediate", []],
  [7, 0, "Probability basics", 66, "immediate", ["Conditional probability", "Bayes' theorem"]],
  [7, 1, "Supply & demand", 88, "retention", []],
  [5, 0, "Probability basics", 70, "retention", ["Bayes' theorem"]],
  [1, 0, "Random variables & distributions", 52, "retention", ["Variance of a sum", "Binomial vs Poisson"]]
];
const DEMO_DAYS = 12;
function loadDemo({ tour = true } = {}) {
  if (S.exams.some(e => e.example)) { go("dashboard"); if (tour) startTour(); return; }
  const t0 = today(), exams = exampleExams();
  const at = (d, h = 18, m = 40) => { const x = pd(d); x.setHours(h, m, 0, 0); return x.toISOString(); };
  const topic = (ei, name) => exams[ei].topics.find(t => t.name === name);
  S.exams.push(...exams);
  fillDemoFingerprint();
  assignMethods(exams);
  // done blocks, one after another from 17:00 on each day
  const clock = {}, from = {};
  for (const [ago, ei, name, kind, minutes] of DEMO_HISTORY) {
    const e = exams[ei], t = topic(ei, name), d = addDays(t0, -ago), start = clock[d] || toMin("17:00");
    clock[d] = start + minutes + 10;
    const b = { id: uid(), date: d, start: fromMin(start), minutes, status: kind === "missed" ? "skipped" : "done", examId: e.id, topicId: t.id, demo: true };
    if (kind === "learn" || kind === "missed") {
      const f = from[t.id] || 0;
      Object.assign(b, { type: "learn", method: t.method || null, goals: goalSpan(t, f, f + minutes), label: `Learn: ${t.name}${t.method ? " (" + METHODS[t.method].name.toLowerCase() + ")" : ""}` });
      if (kind === "learn") from[t.id] = f + minutes;
    } else if (kind === "repair") Object.assign(b, { type: "review", label: `Repair review: ${t.name}` });
    else Object.assign(b, { type: "check", label: `Retention check: ${t.name}` });
    S.blocks.push(b);
  }
  // when each topic was finished, as markDone() records it
  for (const [ei, name, ago] of [[0, "Descriptive statistics", 11], [1, "Supply & demand", 9], [0, "Probability basics", 7], [0, "Random variables & distributions", 3]])
    Object.assign(topic(ei, name), { learnedOn: addDays(t0, -ago), checkPending: true, checkDue: addDays(t0, -ago + 2) });
  // log entries, oldest first; unshifted at the end so the newest is on top
  const entries = [{ at: at(addDays(t0, -DEMO_DAYS), 16, 55), kind: "setup", example: true, title: "Example exams added",
    detail: "Example data: two made-up exams with about two weeks of made-up studying, quizzes and plan changes, so you can see how the coach reacts. Nothing here needed the AI. Remove it on the Today page when you add your own exams.", changes: [] }];
  const missed = S.blocks.find(b => b.demo && b.status === "skipped");
  const events = DEMO_QUIZZES.map(q => ({ ago: q[0], quiz: q })).concat(missed ? [{ ago: diffDays(missed.date, t0), missed }] : []).sort((a, b) => b.ago - a.ago);
  for (const ev of events) {
    const d = addDays(t0, -ev.ago);
    replan();
    const before = futureByTopic();
    if (ev.missed) {
      replan();
      entries.push({ at: at(d, 21, 5), examId: ev.missed.examId, kind: "skip", example: true, title: `Missed: ${ev.missed.label}`, detail: `The ${ev.missed.minutes} min from ${fmtDay(d)} were moved to the next free slots.`, changes: [] });
      continue;
    }
    const [, ei, name, score, kind, missedConcepts] = ev.quiz, e = exams[ei], t = topic(ei, name);
    const r = quizEffect(e, t, score, missedConcepts);
    // dates as on the day of the quiz: entries and repair reviews move back by `ago` days; a review that is past now was done
    t.quizzes[t.quizzes.length - 1].date = d;
    for (const x of e.topics) if (x.reviewDue && x.reviewDue > d) { const due = addDays(x.reviewDue, -ev.ago); x.reviewDue = due < t0 ? null : due; }
    S.fp.quizLog.push({ demo: true, d, h: 18, score, examId: e.id, topicId: t.id, method: t.method || null, kind, delay: diffDays(t.learnedOn, d), energy: null, light: false });
    if (kind === "retention") { t.checkPending = false; t.retention = score; }
    replan();
    const changes = diffTopics(before, futureByTopic());
    entries.push({ at: at(d), examId: e.id, kind: "quiz", example: true, title: r.title, detail: r.detail + (r.verdict === "below" || r.verdict === "above" ? "" : keepText(changes)), score, expected: r.expected, changes });
  }
  S.log.unshift(...entries.reverse());
  selExam = exams[0].id;
  quiz = null;
  commit();
  go("dashboard");
  if (tour) startTour();
}
// "Remove example data": the example exams with their blocks, results and log entries, and the
// simulated learning profile. The student's own exams and results stay.
function removeDemo() {
  const ids = new Set(S.exams.filter(e => e.example).map(e => e.id));
  const tids = new Set(S.exams.filter(e => e.example).flatMap(e => e.topics.map(t => t.id)));
  S.exams = S.exams.filter(e => !e.example);
  S.blocks = S.blocks.filter(b => !ids.has(b.examId));
  S.log = S.log.filter(l => !l.example && !ids.has(l.examId));
  S.fp.quizLog = S.fp.quizLog.filter(q => !ids.has(q.examId));
  S.fp.conf = S.fp.conf.filter(c => !tids.has(c.topicId));
  S.fp.energy = S.fp.energy.filter(x => !tids.has(x.topicId));
  if (S.fp.demo) clearDemoFingerprint();
  quiz = null; selExam = null; demoConfirm = false;
  endTour();
  commit({ log: { kind: "setup", title: "Example data removed", detail: "The example exams, their results and the example learning profile were removed." } });
  go("dashboard");
}

/* ---------- example questions ---------- */
// Built-in multiple-choice questions for some example topics, so a quiz works in the example without
// the AI. Multiple choice is graded on the page, so grading needs no AI either.
const mc = (question, options, answer, concept, modelAnswer, source) => ({ type: "mc", question, options, answer, concept, modelAnswer, source });
const EXAMPLE_QUIZ = {
  "Descriptive statistics": [
    mc("For the data 2, 4, 4, 5, 10, which statement is true?", ["Mean 4, median 5", "Mean 5, median 4", "Mean 5, median 5", "Mean 4, median 4"], 1, "Mean vs median", "The mean is 25 / 5 = 5; the median is the middle value of the sorted data, 4.", "Script p. 3–8"),
    mc("Which measure is least affected by one very large outlier?", ["The mean", "The range", "The median", "The standard deviation"], 2, "Robust measures", "The median only depends on the middle of the sorted data, so one extreme value barely moves it.", "Script p. 3–8"),
    mc("In a box plot, the box spans…", ["the smallest to the largest value", "the mean ± one standard deviation", "the 5th to the 95th percentile", "the middle 50% of the data, from Q1 to Q3"], 3, "Box plots", "The box goes from the first to the third quartile; the line inside it is the median.", "Script p. 9–12"),
    mc("A histogram has a long tail to the right. Which is most likely?", ["It is right-skewed and the mean is above the median", "It is left-skewed and the mean is above the median", "It is symmetric, so mean and median are equal", "It is right-skewed and the mean is below the median"], 0, "Skewness", "A long right tail pulls the mean up, so in a right-skewed distribution the mean is usually above the median.", "Script p. 9–12")
  ],
  "Probability basics": [
    mc("P(A) = 0.5, P(B) = 0.4 and P(A ∩ B) = 0.2. What is P(A ∪ B)?", ["0.9", "0.7", "0.2", "0.5"], 1, "Addition rule", "P(A ∪ B) = P(A) + P(B) − P(A ∩ B) = 0.5 + 0.4 − 0.2 = 0.7.", "Script p. 14–18"),
    mc("With the same numbers, what is P(A | B)?", ["0.5", "0.4", "0.2", "0.8"], 0, "Conditional probability", "P(A | B) = P(A ∩ B) / P(B) = 0.2 / 0.4 = 0.5.", "Script p. 19–22"),
    mc("A and B are independent, P(A) = 0.3 and P(B) = 0.5. What is P(A ∩ B)?", ["0.8", "0.65", "0.15", "0.2"], 2, "Multiplication rule", "For independent events P(A ∩ B) = P(A) · P(B) = 0.15.", "Script p. 14–18"),
    mc("1% of people have a disease. A test finds 90% of the sick, but is also positive for 10% of the healthy. Someone tests positive. How likely are they sick?", ["About 90%", "About 50%", "About 1%", "About 8%"], 3, "Bayes' theorem", "P(sick | positive) = 0.01 · 0.9 / (0.01 · 0.9 + 0.99 · 0.1) = 0.009 / 0.108 ≈ 0.08.", "Script p. 23–26"),
    mc("A and B are mutually exclusive. What is P(A ∩ B)?", ["0", "P(A) · P(B)", "P(A) + P(B)", "1"], 0, "Mutually exclusive events", "Mutually exclusive events can't happen together, so P(A ∩ B) = 0.", "Script p. 14–18")
  ],
  "Random variables & distributions": [
    mc("X takes the values 0, 1 and 2 with probabilities 0.2, 0.5 and 0.3. What is E(X)?", ["1", "1.1", "1.5", "0.9"], 1, "Expected value", "E(X) = 0 · 0.2 + 1 · 0.5 + 2 · 0.3 = 1.1.", "Script p. 28–32"),
    mc("X and Y are independent with Var(X) = 4 and Var(Y) = 9. What is Var(X − Y)?", ["5", "−5", "13", "36"], 2, "Variance of a sum", "For independent variables the variances add up, also for a difference: Var(X − Y) = 4 + 9 = 13.", "Script p. 28–32"),
    mc("X ~ Bin(n = 10, p = 0.3). What are E(X) and Var(X)?", ["3 and 2.1", "3 and 0.21", "3 and 3", "0.3 and 2.1"], 0, "Binomial distribution", "E(X) = n·p = 3 and Var(X) = n·p·(1 − p) = 10 · 0.3 · 0.7 = 2.1.", "Script p. 33–37"),
    mc("A help desk gets 4 calls per hour on average, independently of each other. Which model fits the number of calls in an hour?", ["Bin(n = 4, p = 0.5)", "Uniform on 0 to 8", "Normal with mean 4 and standard deviation 4", "Poisson with λ = 4"], 3, "Binomial vs Poisson", "Counts of independent events in a fixed time with a known average rate follow a Poisson distribution; there is no fixed number of trials n.", "Script p. 38–41"),
    mc("X ~ Poisson(λ = 2). What is P(X = 0)?", ["0", "About 0.14", "0.5", "About 0.27"], 1, "Poisson distribution", "P(X = 0) = e^(−2) ≈ 0.135.", "Script p. 38–41")
  ],
  "Normal distribution & CLT": [
    mc("X ~ N(100, 15²). What is the z-score of x = 130?", ["30", "0.5", "2", "1.5"], 2, "Standardising", "z = (130 − 100) / 15 = 2.", "Script p. 43–47"),
    mc("About what share of a normal distribution lies within ±1.96 standard deviations of the mean?", ["68%", "90%", "99.7%", "95%"], 3, "z-table", "±1.96 standard deviations cover 95%; ±1 covers about 68%.", "Script p. 43–47"),
    mc("A population has σ = 12. What is the standard error of the mean of a sample of n = 36?", ["2", "12", "1/3", "6"], 0, "Standard error", "σ / √n = 12 / 6 = 2.", "Script p. 48–52"),
    mc("What does the central limit theorem say for large samples?", ["The population becomes normally distributed", "The sample mean is approximately normally distributed, whatever the population's distribution", "Every sample looks like a normal distribution", "The sample mean always equals the population mean"], 1, "Central limit theorem", "For large n the distribution of the sample mean is approximately normal (for any population with a finite variance), with standard error σ / √n.", "Script p. 48–52")
  ],
  "Supply & demand": [
    mc("Demand is Qd = 100 − 2P and supply is Qs = 20 + 2P. What is the equilibrium?", ["P = 25, Q = 50", "P = 20, Q = 40", "P = 20, Q = 60", "P = 40, Q = 20"], 2, "Market equilibrium", "100 − 2P = 20 + 2P gives P = 20, and Q = 100 − 40 = 60.", "Slides 3–9"),
    mc("Incomes rise and the good is a normal good. What happens?", ["The demand curve shifts right: price and quantity rise", "A movement along the demand curve", "The supply curve shifts right: the price falls", "The demand curve shifts left"], 0, "Demand curve shifts", "Higher income raises demand for a normal good at every price, so the demand curve shifts right; price and quantity rise.", "Slides 10–15"),
    mc("A maximum price is set below the equilibrium price. What follows?", ["A surplus", "No effect", "More is traded than before", "A shortage (excess demand)"], 3, "Price ceilings", "At a price below equilibrium, quantity demanded is above quantity supplied: a shortage.", "Slides 10–15"),
    mc("A cheaper production technology becomes available. What happens?", ["Demand shifts right", "Supply shifts right: lower price, higher quantity", "Supply shifts left: higher price", "Nothing, only firms' profits change"], 1, "Supply shifts", "Lower costs mean more is supplied at every price, so the supply curve shifts right.", "Slides 10–15")
  ],
  "Elasticities": [
    mc("The price rises by 10% and the quantity demanded falls by 20%. What is the price elasticity of demand?", ["−0.5, inelastic", "−2, inelastic", "+2", "−2, elastic"], 3, "Price elasticity of demand", "ε = −20% / 10% = −2; its absolute value is above 1, so demand is elastic.", "Slides 17–22"),
    mc("Demand is price-inelastic. What does a price increase do to total revenue?", ["It rises", "It falls", "It stays the same", "It falls to zero"], 0, "Elasticity and revenue", "With inelastic demand the quantity falls by a smaller percentage than the price rises, so revenue P · Q rises.", "Slides 17–22"),
    mc("A good has an income elasticity of −0.4. What kind of good is it?", ["A luxury good", "An inferior good", "A normal necessity", "A complement"], 1, "Income elasticity", "A negative income elasticity means demand falls when income rises: an inferior good.", "Slides 23–26"),
    mc("The cross-price elasticity between coffee and tea is positive. The two are…", ["complements", "unrelated", "substitutes", "inferior goods"], 2, "Cross elasticity", "When tea gets more expensive, people buy more coffee: a positive cross elasticity means substitutes.", "Slides 23–26")
  ]
};
const exampleBank = (e, t) => e && e.example && t ? EXAMPLE_QUIZ[t.name] || null : null;
// Button on the quiz page for example topics with built-in questions.
function exampleQuizButton(e, t) {
  const bank = exampleBank(e, t);
  if (!bank || ["loading", "grading"].includes(quiz && quiz.phase)) return "";
  return `<button class="btn ${sample ? "" : "primary"}" data-act="quiz-example">Use the example questions (no AI needed)</button>`;
}
function startExampleQuiz() {
  const e = examById(quiz && quiz.examId), t = topicById(e, quiz && quiz.topicId), bank = exampleBank(e, t);
  if (!bank) return;
  quiz = { examId: e.id, topicId: t.id, phase: "answer", n: bank.length, answers: {}, questions: bank.map(q => ({ ...q, options: [...q.options] })),
    note: "These are built-in example questions, so no AI is needed. For your own exams, the AI writes the questions from your materials, in the style of your old exams." };
  render();
}

/* ---------- example banner ---------- */
let demoConfirm = false;
function demoBanner() {
  if (!S.exams.some(e => e.example)) return "";
  const history = S.blocks.some(b => b.demo);
  return `<section class="alert mark" id="demo-banner"><div class="stack" style="gap:6px">
    <b>You're looking at example data</b>
    <span class="small">${history ? "Two made-up exams with two weeks of made-up studying: quizzes, a result below plan that made the coach change the plan, and an example learning profile." : "Two made-up exams with sample topics."} Nothing here needs the AI.</span>
    <div class="row"><button class="btn sm primary" data-act="tour">Take the tour (1 min)</button><button class="btn sm" data-view="how">How it works</button>
    <button class="btn sm ghost" data-act="rm-example">${demoConfirm ? "Click again to remove the example data" : "Remove example data"}</button></div></div></section>`;
}

/* ---------- guided tour ---------- */
// Six steps over the real pages: plan → today → quiz → plan changes → learning profile → how it works.
// The tour card sits outside #main (which is re-rendered), is not modal, and works with the keyboard:
// Tab between its buttons, Enter, → / ← for next / back, Esc to close. Focus goes back where it was.
let TOUR = null;
const demoExam = () => S.exams.find(e => e.example && e.topics.length) || S.exams.find(e => e.topics.length) || null;
const rootEntry = () => S.log.find(l => /probably comes from/.test(l.detail || ""));
const TOUR_STEPS = [
  { view: "plan", el: "#weeks", title: "A plan built backwards from the exam date",
    text: () => "The coach starts at the exam date and works backwards: a final review on the eve, a mock exam a few days before, retention checks and spaced reviews, and learning blocks in the order of the material, each after the topics it builds on. Every block says which pages, what to do and what you should have at the end." },
  { view: "dashboard", el: "#now", title: "Today: one clear next step",
    text: () => { const b = S.blocks.find(x => x.status === "planned" && x.date === today());
      return b && /^Repair review/.test(b.label) ? `Today starts with “${b.label}”. Nobody planned that by hand: the coach added it after yesterday's quiz. Step 4 shows why.`
        : "The next block to do, with what it covers and one button to start it. Done and missed blocks change the plan for the following days."; } },
  { view: "quiz", el: "#quiz-pick", title: "Take a quiz after a block",
    before: () => { const e = demoExam(); if (!e) return; const t = e.topics.find(x => x.name === "Probability basics") || e.topics[0];
      if (!quiz || !["answer", "grading", "done"].includes(quiz.phase)) quiz = { examId: e.id, topicId: t.id, phase: "pick" }; },
    text: () => `The AI writes questions from your own materials, in the style of your old exams.${demoExam() && demoExam().example ? " The example topics also have built-in questions, so you can try it now without the AI." : ""} Your score is compared with where the plan expects you to be by now: below that, the plan changes.` },
  { view: "history", el: ".logitem", title: "What the coach changed, and why",
    text: () => { const r = rootEntry();
      return `Every change to the plan is listed here with its reason and the hours it moved.${r ? " In the example, a low score on Random variables made the coach check what that topic builds on, so the repair time went to Probability basics first." : ""} You never have to re-plan by hand.`; } },
  { view: "you", el: ".fpcard", title: "Your learning profile",
    text: () => `The coach tries different study methods on your topics and checks what you still know 2 days later. It also measures how fast you forget, when you're sharpest and how long you focus, and changes your plan from that.${S.fp.demo ? " The numbers here are example data and marked as such." : ""}` },
  { view: "how", el: "#how-loop", title: "That's the loop",
    text: () => "Plan, study, quiz, compare, change the plan, and the learning profile makes every round fit you better. This page explains it in a few lines, including what a chatbot can't do here." }
];
function startTour(i = 0) {
  const back = TOUR ? TOUR.back : document.activeElement;
  TOUR = { i: Math.max(0, Math.min(TOUR_STEPS.length - 1, i)), back };
  tourShow();
}
function tourShow() {
  const st = TOUR_STEPS[TOUR.i];
  if (st.before) st.before();
  go(st.view);
}
function tourMove(d) {
  if (!TOUR) return;
  const i = TOUR.i + d;
  if (i >= TOUR_STEPS.length) return endTour();
  if (i < 0) return;
  TOUR.i = i; tourShow();
}
function endTour() {
  if (!TOUR) return;
  const back = TOUR.back;
  TOUR = null;
  document.querySelectorAll(".tour-on").forEach(x => x.classList.remove("tour-on"));
  const box = document.getElementById("tour"); if (box) box.remove();
  // back where the tour was started if that is still on the page, else the tab of the page shown now
  const again = back && back.dataset && back.dataset.act && document.querySelector(`#main [data-act="${back.dataset.act}"]`);
  const to = back && back.isConnected && back !== document.body ? back : again || document.querySelector("#nav [aria-current='page']");
  if (to && to.focus) to.focus();
}
// Called by render(): marks the step's element and keeps the tour card up to date.
function tourAfterRender() {
  document.querySelectorAll(".tour-on").forEach(x => x.classList.remove("tour-on"));
  if (!TOUR) return;
  const st = TOUR_STEPS[TOUR.i], n = TOUR_STEPS.length, last = TOUR.i === n - 1;
  let box = document.getElementById("tour");
  const fresh = !box || box.dataset.step !== String(TOUR.i);
  if (!box) {
    box = document.createElement("div");
    box.id = "tour"; box.className = "tour"; box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "false");
    box.setAttribute("aria-labelledby", "tour-title"); box.setAttribute("aria-describedby", "tour-text");
    document.body.appendChild(box);
  }
  if (fresh) {
    box.dataset.step = String(TOUR.i);
    box.innerHTML = `<div class="row" style="justify-content:space-between"><span class="label">Tour · step ${TOUR.i + 1} of ${n}</span><button class="btn sm ghost" data-tour="skip" aria-label="Close the tour">Skip tour</button></div>
      <h2 id="tour-title">${esc(st.title)}</h2><p id="tour-text">${esc(st.text())}</p>
      <div class="row"><button class="btn primary" data-tour="next">${last ? "Finish" : "Next"}</button>${TOUR.i ? `<button class="btn" data-tour="back">Back</button>` : ""}
      <span class="small muted tour-keys">← → to move, Esc to close</span></div>
      <ol class="tour-dots" aria-hidden="true">${TOUR_STEPS.map((_, k) => `<li class="${k === TOUR.i ? "on" : ""}"></li>`).join("")}</ol>`;
  }
  const el = st.el && document.querySelector("#main " + st.el);
  if (el) {
    el.classList.add("tour-on");
    if (fresh) el.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
  if (fresh) box.querySelector('[data-tour="next"]').focus({ preventScroll: true });
}

/* ---------- how it works ---------- */
function howDiagram() {
  const node = (x, y, w, title, sub, cls = "") => `<g class="hw-node ${cls}"><rect x="${x}" y="${y}" width="${w}" height="66" rx="10"/><text x="${x + w / 2}" y="${y + 28}" class="hw-t">${title}</text><text x="${x + w / 2}" y="${y + 48}" class="hw-s">${sub}</text></g>`;
  const arrow = (d, dashed) => `<path d="${d}" class="hw-a${dashed ? " dashed" : ""}" marker-end="url(#hw-head)"/>`;
  const lab = (x, y, t, anchor = "middle") => `<text x="${x}" y="${y}" class="hw-l" text-anchor="${anchor}">${t}</text>`;
  return `<svg id="how-loop" class="how-svg" viewBox="0 0 720 372" role="img" aria-labelledby="how-svg-t how-svg-d">
    <title id="how-svg-t">The feedback loop</title>
    <desc id="how-svg-d">1. Plan backwards from the exam date. 2. Study a block. 3. Take a quiz. 4. Compare the score with where the plan expects you to be. 5. If it is more than 10 points below, change the plan: more time and a repair review, and back to 1. Every result also goes into the learning profile, which decides the study methods and review gaps.</desc>
    <defs><marker id="hw-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="hw-head"/></marker></defs>
    ${node(20, 20, 200, "1 · Plan backwards", "from the exam date", "key")}
    ${node(260, 20, 200, "2 · Study a block", "pages, method, goal")}
    ${node(500, 20, 200, "3 · Quiz", "from your materials")}
    ${node(500, 170, 200, "4 · Compare", "score vs. expected by now")}
    ${node(140, 170, 200, "5 · Change the plan", "more time, repair review", "key")}
    ${node(20, 292, 680, "Learning profile", "which methods work for you · how fast you forget · when you're sharpest", "profile")}
    ${arrow("M220 53 L256 53")}${arrow("M460 53 L496 53")}${arrow("M600 86 L600 166")}
    ${arrow("M500 203 L344 203")}${arrow("M200 170 C 200 130, 120 130, 120 90")}
    ${arrow("M640 236 L640 288", true)}${arrow("M250 288 L250 240", true)}
    ${lab(422, 194, "10+ points below")}
    ${lab(128, 146, "rebuilt from today", "end")}
    ${lab(648, 268, "every result", "start")}
    ${lab(258, 268, "methods, review gaps", "start")}
  </svg>`;
}
function vHow() {
  const rows = [
    ["Remembers your results", "Only what you paste into the chat again.", "Every block, quiz and mock exam is saved in your browser and used for the next decision."],
    ["Changes the plan by itself", "Only when you ask, and you have to say what happened.", "After every quiz, mock exam or missed block, with the reason and the hours moved in Plan changes."],
    ["Spaced reviews at the right time", "Can explain spacing, but doesn't put the reviews into your week.", "A retention check 2 days after you finish a topic and a spaced review later, both in your calendar."],
    ["Finds the cause of a low score", "Sees one question at a time.", "Checks what a weak topic builds on and repairs that first."],
    ["Knows which study methods work for you", "Guesses from how you describe yourself.", "Measures it: what you still know 2 days later, per method."],
    ["Your materials", "Uploaded again in every new conversation.", "Uploaded once; the plan points to the pages for each block."]
  ];
  const ex = S.exams.some(e => e.example);
  return `<section class="section how">
    <div class="section-head"><h2>How Exam Coach works</h2><span class="small muted">The idea in two minutes</span></div>
    <p style="max-width:70ch">A study plan is only useful if it stays true. Exam Coach builds your plan backwards from the exam date, checks with short quizzes whether you are where you should be, and changes the plan by itself when you're not.</p>
  </section>
  <section class="panel stack">${howDiagram()}</section>
  <div class="grid2">
    <section class="panel stack"><h3>The feedback loop</h3>
      <p class="small">Each topic has a target (for example 80%) and a share of its study time already done. The coach expects target × progress: with half the time done, 40%.</p>
      <ul class="small how-list">
        <li><b>More than 10 points below:</b> extra study time and a repair review tomorrow, taken from later, lower-priority blocks. The next quiz focuses on what you got wrong.</li>
        <li><b>Below because of an earlier topic:</b> if the topic builds on one that is weak, the repair goes there first. “Your trouble with X probably comes from Y.”</li>
        <li><b>Well above the target:</b> review time is freed for weaker topics.</li>
        <li><b>Not learned yet:</b> a low score on a topic you haven't finished doesn't count as behind.</li>
      </ul>
      <p class="small muted">Every change is listed under Plan changes, with its reason.</p></section>
    <section class="panel stack"><h3>The learning profile</h3>
      <p class="small">Instead of a learning-style label, the coach runs small experiments on you.</p>
      <ul class="small how-list">
        <li><b>Study methods:</b> topics are learned with different methods (practice problems, worked examples, flashcards, explaining it back, summaries). A short check 2 days later shows what stuck; then most topics use your best method.</li>
        <li><b>Forgetting speed:</b> the score right after learning vs. 2 days later sets the gap to the next review.</li>
        <li><b>Time of day, focus span, confidence and energy:</b> when your results are best, how long you really focus, whether “sure” answers are right, and how tiredness changes your scores.</li>
      </ul>
      <p class="small muted">Each finding says how sure the coach is and what it changes in your plan.</p></section>
  </div>
  <section class="panel stack" id="how-chatbot"><h3>What a chatbot can't do here</h3>
    <p class="small" style="max-width:75ch">A chatbot is good at explaining a topic, writing practice questions and giving feedback on an answer, and Exam Coach uses an AI for exactly those parts. The difference is everything around them:</p>
    <div class="tablewrap"><table class="how-table"><thead><tr><th scope="col"></th><th scope="col">Asking a chatbot</th><th scope="col">Exam Coach</th></tr></thead>
      <tbody>${rows.map(([a, b, c]) => `<tr><th scope="row">${a}</th><td>${b}</td><td>${c}</td></tr>`).join("")}</tbody></table></div>
  </section>
  <section class="panel stack"><h3>Your data</h3><p class="small" style="max-width:75ch">There are no accounts. Your plan, results and materials are saved in this browser only. Only the text needed for an AI request (for example a few pages for a quiz) is sent, and nothing is stored on the server.</p></section>
  <div class="row">${ex ? `<button class="btn primary" data-act="tour">Take the tour</button><button class="btn" data-view="dashboard">Back to today</button>`
    : `<button class="btn primary" data-act="demo">Try it with example exams</button>${S.exams.length ? `<button class="btn" data-view="dashboard">Back to today</button>` : `<button class="btn" data-act="new-exam">Add your first exam</button>`}`}</div>`;
}

/* ---------- events ---------- */
document.getElementById("main").addEventListener("click", ev => {
  const el = ev.target.closest("[data-act]"); if (!el) return;
  const a = el.dataset.act;
  if (a !== "rm-example") demoConfirm = false;
  if (a === "demo") loadDemo();
  else if (a === "tour") { if (!S.exams.some(e => e.topics.length)) loadDemo(); else startTour(); }
  else if (a === "quiz-example") startExampleQuiz();
  else if (a === "rm-example") { if (!demoConfirm) { demoConfirm = true; render(); } else removeDemo(); }
});
document.addEventListener("click", ev => {
  const b = ev.target.closest("#tour [data-tour]"); if (!b) return;
  const k = b.dataset.tour;
  if (k === "next") tourMove(1); else if (k === "back") tourMove(-1); else endTour();
});
document.addEventListener("keydown", ev => {
  if (!TOUR || ev.altKey || ev.ctrlKey || ev.metaKey) return;
  const typing = ev.target.closest && ev.target.closest("input, textarea, select, [contenteditable]");
  if (ev.key === "Escape") { ev.preventDefault(); endTour(); }
  else if (!typing && ev.key === "ArrowRight") { ev.preventDefault(); tourMove(1); }
  else if (!typing && ev.key === "ArrowLeft") { ev.preventDefault(); tourMove(-1); }
});
