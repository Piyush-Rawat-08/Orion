// Screens, their shortcuts and the copy for the top bar.

// 16px line icons on one grid: 1.5 stroke, round caps, drawn for what each screen does rather than picked
// from a set (the Org icon is the official team and the real one overlapping).
const I = {
  brain: (
    <>
      <circle cx="3.9" cy="11.6" r="1.7" />
      <circle cx="12" cy="4.2" r="1.7" />
      <circle cx="12.4" cy="12.4" r="1.4" />
      <path d="M5.3 10.4l5.4-5M5.6 11.9h5.4M12.1 5.9l.2 5.1" />
    </>
  ),
  multiverse: (
    <>
      <circle cx="4.5" cy="3.4" r="1.5" />
      <circle cx="4.5" cy="12.6" r="1.5" />
      <circle cx="11.6" cy="4.6" r="1.5" />
      <path d="M4.5 4.9v6.2M11.6 6.1c0 3.4-7.1 2.1-7.1 5" />
    </>
  ),
  review: (
    <>
      <rect x="2.3" y="2.8" width="11.4" height="10.4" rx="2.6" strokeDasharray="2.3 1.9" />
      <path d="M6.8 5.9v4.2l3.3-2.1z" fill="currentColor" strokeWidth="1" />
    </>
  ),
  time: (
    <>
      <circle cx="8" cy="8" r="5.7" />
      <path d="M8 4.9v3.3l2.1 1.3" />
    </>
  ),
  org: (
    <>
      <circle cx="6" cy="8" r="3.9" />
      <circle cx="10" cy="8" r="3.9" strokeDasharray="2.1 1.6" />
    </>
  ),
  repos: (
    <>
      <path d="M3.8 12.6V4.1c0-.9.7-1.6 1.6-1.6h7v8.6H5.4c-.9 0-1.6.7-1.6 1.6s.7 1.6 1.6 1.6h7" />
      <path d="M6.5 5.3h3.2" />
    </>
  ),
  activity: <path d="M1.8 8.6h2.6l1.9-4.6 3.3 8.1 1.8-3.5h2.8" />,
  // a clock whose hand runs backwards: looking back at what happened
  hindsight: (
    <>
      <path d="M2.6 6.2A5.7 5.7 0 1 1 2.4 9.4" />
      <path d="M2.2 3.4v2.9h2.9" />
      <path d="M8 5.2v2.9l-1.9 1.2" />
    </>
  ),
  // bars side by side with a check: the head-to-head
  proof: (
    <>
      <path d="M3 13.2V8.4M6.6 13.2V5.2M10.2 13.2V9.6" />
      <path d="M10.6 4.6l1.5 1.5 2.6-2.9" />
    </>
  ),
  inbox: (
    <>
      <path d="M2.4 9.4l1.8-5.6h7.6l1.8 5.6v2.8c0 .6-.4 1-1 1H3.4c-.6 0-1-.4-1-1z" />
      <path d="M2.4 9.4h3.1l.8 1.4h3.4l.8-1.4h3.1" />
    </>
  ),
};


// The main rail leads with what a first visitor should see (ask, try a change, the replayed outage, the head-to-head),
// then the screens a team uses day to day; the rest sits behind "More". Inbox only makes sense after someone has asked
// something, so it waits there and comes forward on its own when an answer goes out of date. Titles and descriptions
// are plain words: nobody should need to know what a fork, a graph or a query is to use a screen.
export const NAV = [
  { href: "/", label: "Ask", key: "1", icon: I.brain, group: "lead", more: false, title: "Ask", sub: "Ask anything about Corvane. Every point in the answer is checked against the records." },
  { href: "/multiverse", label: "What-ifs", key: "2", icon: I.multiverse, group: "lead", more: false, title: "What-ifs", sub: "Try a change on a copy of the company and see what it would affect. Nothing real changes." },
  { href: "/hindsight", label: "Hindsight", key: "9", icon: I.hindsight, group: "lead", more: false, title: "Hindsight", sub: "Would Orion have caught it? Each incident replayed against the decision that led to it." },
  { href: "/proof", label: "Proof", key: "0", icon: I.proof, group: "lead", more: false, title: "Proof", sub: "Orion against the same model reading the same records, on questions the records can settle." },
  { href: "/review", label: "Approvals", key: "3", icon: I.review, group: "team", more: false, title: "Approvals", sub: "Changes waiting for sign-off. Nothing happens until the teams responsible approve." },
  { href: "/time", label: "History", key: "5", icon: I.time, group: "team", more: false, title: "History", sub: "The company as it was on any day since January 2024." },
  { href: "/org", label: "Teams", key: "6", icon: I.org, group: "team", more: false, title: "Teams in practice", sub: "The org chart next to the groups people actually work in." },
  { href: "/inbox", label: "Inbox", key: "4", icon: I.inbox, group: "more", more: true, title: "Inbox", sub: "Answers you were given that are no longer true, and what changed." },
  { href: "/repos", label: "Codebases", key: "7", icon: I.repos, group: "more", more: true, title: "Codebases", sub: "Load a GitHub project to see who knows each part of it and which parts are risky." },
  { href: "/activity", label: "Activity", key: "8", icon: I.activity, group: "more", more: true, title: "Activity", sub: "What the assistants are working on right now." },
] as const;
