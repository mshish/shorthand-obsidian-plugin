---
title: Settings copy style
---

# Settings copy style

Nine rules for the text in Shorthand's settings tab. Each rule states the source it comes
from, and each example is this plugin's own copy: the don't side is what shipped, the do side
is what replaces it.

## Why this exists

`AGENTS.md` used to say that settings copy should "match the register of the existing
settings descriptions". That rule ratchets in one direction only. Every new description was
written against the longest one already on the tab, and the longest one kept moving. The
description for **Control Shorthand recording** reached five sentences and ended on the
relaunch bias of a cancel signal. Someone deciding whether to flip that switch reads a
paragraph about internal mechanism and still does not learn what changes for them.

The objection to writing plainly is that Obsidian users are technical and want the mechanism
spelled out. The evidence says the opposite. GOV.UK's
[Use clear language](https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/writing-guidelines/clear-language/)
reports that "80% of people preferred sentences written in clear English", and that in
research into specialist legal language "the more educated the person and the more specialist
their knowledge, the greater their preference for plain English". A technical audience is a
reason to write plainer copy.

<a id="rule-1"></a>

## Rule 1 — One sentence. Three is the absolute ceiling.

Obsidian's [Settings guide](https://docs.obsidian.md/Plugins/User+interface/Settings):
"`desc` is for a single sentence explaining what the setting does, not for warnings or
paragraphs of context. Long descriptions push the next row off-screen, disrupt scanning, and
aren't guaranteed to be read."

Overflow has a prescribed destination, from the same page: "If the user needs background
context to understand the setting, link to a docs page from `desc` rather than inlining it."
In this repo the docs page is `README.md`, linked by URL from a `DocumentFragment`.

- **Don't** — the old **Control Shorthand recording**, five sentences ending "The consequence
  of that bias: quitting Shorthand in the middle of a capture normally does relaunch it,
  because the cancel is sent whenever there is any chance a recording is still running."
- **Do** — "Starting and stopping a capture also starts and stops Shorthand, so you don't
  need its hotkey. Quitting Shorthand mid-capture normally relaunches it — see
  [Driving Shorthand's recorder]." Two sentences and a link; the paragraph the link replaces
  is still in `README.md`, word for word.

<a id="rule-2"></a>

## Rule 2 — No description is a valid outcome.

Write one only when the label leaves a real question unanswered.

Android's [settings guidance](https://developer.android.com/design/ui/mobile/guides/patterns/settings):
"If the label is sufficient on its own, don't add secondary text."
Microsoft's [Win32 UX guide](https://learn.microsoft.com/en-us/windows/win32/uxguide/text-ui):
"Don't have supplemental explanations that merely restate the label for consistency."

- **Don't** — **Provider**, "Select the API family used for enhancement requests." The label
  says Provider; the dropdown shows which one. The sentence adds nothing.
- **Do** — **Provider**, no `setDesc` call at all.

<a id="rule-3"></a>

## Rule 3 — Describe the consequence, not the mechanism.

[Material's](https://m1.material.io/patterns/settings.html) worked pair keeps the label `NFC`
on both sides and changes only the secondary text: DO `Allow data exchange when the phone
touches another device`; DON'T `Use Near Field Communication to read and exchange tags`. The
label is identical in both, so the pair isolates one variable, the description, and shows the
same row rewritten from what the feature is into what it does for you.

- **Don't** — **Enhancement backend**, "Choose whether note enhancement uses the Claude Agent
  SDK or a directly configured LLM provider." That is the dropdown read back as a sentence.
- **Do** — "The Claude Agent SDK backend can look things up elsewhere in your vault; an LLM
  provider cannot." That is the difference the choice actually makes, and it is the reason a
  user would pick one.

Second pair, because "mechanism" here often means core's vocabulary leaking into the pane:

- **Don't** — **Enable live enhancement**, "Run tick passes while capture is active. Stop and
  Enhance now still use a link-tier pass." "Tick pass" and "link tier" are names from
  `shorthand-core`'s state machine. No user has ever seen either word.
- **Do** — "The note is rewritten while the meeting runs, instead of only when you stop or run
  Enhance now."

<a id="rule-4"></a>

## Rule 4 — For non-boolean settings, show the current value instead of a description.

[Material](https://m1.material.io/patterns/settings.html): for a setting that is not a switch,
secondary text "should only show the current status of a setting". Its pair is
`Sleep / After 10 minutes of inactivity`, not `Screen timeout / Adjust the delay before the
screen automatically turns off`.

**The refinement this repo applies, and why.** Material's example is a row that opens a
dialog: the value is not on screen, so the description is the only place it can appear. A text
field or a dropdown already renders its value. Restating it there would violate rule 2 and
Microsoft's "don't restate the label" in the same breath. So rule 4 fires here in exactly two
situations:

1. **The raw value is not self-describing.** `25000` in a number field is not "25 seconds",
   and nothing on screen says which unit it is.
2. **The stored value is not what the field shows.** `normalizePluginSettings` is the trust
   boundary for `data.json` and rewrites what it is given — a rejected folder path falls back
   to the default. The field shows what was typed; the description shows what is in force.

When neither applies, rule 2 wins and the row gets no description.

- **Don't** — **Minimum interval (ms)**, "Minimum time between completed live passes."
- **Do** — **Minimum interval (seconds)**, "Live passes run no more often than once every 25
  seconds." The current value is re-rendered on every edit.
- **Don't** — **Transcript sidecar directory**, "Vault-relative directory used for new
  transcript notes."
- **Do** — **Transcript folder**, "New transcript notes go in Meetings/Transcripts."

Put every string of this shape in a pure function in
[`src/settings-display.ts`](../src/settings-display.ts). Never build one inline in `main.ts`,
because `main.ts` cannot be imported under `bun test` and the string would go untested.

<a id="rule-5"></a>

## Rule 5 — Name toggles as positive noun phrases.

Nielsen Norman Group's
[toggle-switch guidelines](https://www.nngroup.com/articles/toggle-switch-guidelines/): "When
in doubt, say the label aloud and append 'on/off' to the end. If it doesn't make sense, then
rewrite the label." Never phrase a toggle so that on means off.

- **Don't** — **Write transcript note**. "Write transcript note: on" reads as an instruction
  with a state stapled to it.
- **Do** — **Transcript notes**. "Transcript notes: on" parses.
- **Don't** — **Enable live enhancement**. "Enable live enhancement: on" is "enable: on".
- **Do** — **Live enhancement**.

**The aloud test is the operative one; the noun-phrase preference yields to it.**
**Control Shorthand recording** stays a verb phrase, because "Shorthand recorder control"
loses the fact that it is *this plugin* doing the controlling, and "Control Shorthand
recording: on" passes the aloud test cleanly. Prefer the noun phrase; keep the verb phrase
when the noun form drops the object.

<a id="rule-6"></a>

## Rule 6 — Banned generic verbs in naming labels.

Android's
[settings guidance](https://developer.android.com/design/ui/mobile/guides/patterns/settings):
labels must not "use generic terms, such as: Set, Change, Edit, Modify, Manage, Use, Select,
or Choose."

The ban applies to **naming labels** — anything that names a thing rather than invokes an
action: setting names, headings, and the option text of a dropdown or radio. In those
positions a generic verb displaces the noun that would have carried the meaning.

It does **not** apply to **action buttons**. A button's job is to invoke, so an imperative
verb is the correct part of speech there, and Obsidian's own UI is built from "Edit", "Save",
"Cancel". Forcing a noun onto a button produces worse copy, not better.

A description may use any of these words when it is the accurate verb.

- **Don't** — the provider dropdown's placeholder option, "Select a provider". It is option
  text, so it names a state and must not issue an order.
- **Do** — "No provider chosen".
- **Don't** — a mode option reading "Use default". Same position, same problem: the verb adds
  nothing and "Default" alone is unambiguous next to "Custom".
- **Do** — name the prompt modal's two mode options **Default** and **Custom**.
- **Allowed** — the prompt row's **Edit…** button. An action button, not a naming label. The
  ellipsis follows the platform convention for an action that opens a further window.

<a id="rule-7"></a>

## Rule 7 — Obsidian's terminology list is binding.

From Obsidian's [style guide](https://obsidian.md/help/style-guide): "Prefer 'folder' over
'directory'"; "Prefer 'maximum' over 'max' and 'minimum' over 'min'"; "note" for a Markdown
file in the vault. American spelling.

- **Don't** — **Transcript sidecar directory**.
- **Do** — **Transcript folder**. "Sidecar" is core's word for the file; a user sees a note in
  a folder.
- **Do** — **Minimum interval**, **Minimum new characters**. Already correct; do not
  abbreviate them back.

<a id="rule-8"></a>

## Rule 8 — Sentence case throughout. Periods on descriptions, never on labels.

Obsidian's [plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines):
"Any text in UI elements should be using Sentence case instead of Title Case". Microsoft:
"Don't place [periods] at the end of control labels, main instructions, or Help links... Place
at the end of supplemental instructions, supplemental explanations, or any other static text
that forms a complete sentence."

Headings follow the same rule and must not contain the word "settings" — Obsidian's guidance
is to prefer "Advanced" over "Advanced settings".

- **Do** — **LLM provider profile** (heading, no period), "The API key is stored outside your
  vault, so it never syncs." (description, period).
- **Don't** — a fragment with a period bolted on. If it is not a sentence, it gets no period;
  if that feels wrong, it should have been a sentence.

<a id="rule-9"></a>

## Rule 9 — Second person, present tense, active voice. No "we".

This one is a repository convention, not a quotation. The closest published guidance is
Microsoft's, and it does not reach this far: "write the supplemental text in second person"
is scoped to explanations that follow a command link, not to settings descriptions. Obsidian's
style guide governs help documentation rather than plugin UI. So the rule stands on its own
and is labelled as such, the same way the command-naming rule is.

- **Do** — "Turn this on if a note stops updating during capture."
- **Don't** — "It will be created only after a valid edit is committed." Passive, future, and
  it hides who does the committing.
- **Do** — "The profile is written once every required field has a value."

## Obsidian's other binding rules

These govern the tab rather than a single string, so they are not among the nine, but they bind
in the same way.

- **No top-level heading naming the plugin.** "Avoid adding a top-level heading in the settings
  tab, such as 'General', 'Settings', or the name of your plugin." The tab is already titled
  Shorthand, and headings start at the second distinct section.
- **Multi-line input belongs in a form modal.** A textarea "is much taller than every other
  control and disrupts the regular row rhythm of the tab". The note-taking prompt and the
  starting sections are edited in `NotePromptModal` for that reason.
- **Command names carry no plugin name.** Obsidian prefixes them in the palette, so **Enhance
  now** appears as "Shorthand: Enhance now"; see `README.md` § Commands. The three recorder
  commands name Shorthand because they drive the external recorder, not because they name the
  plugin.
- **No hardcoded styling.** "Hardcoding the styling in the plugin code makes it impossible to
  modify with themes and snippets." Use Obsidian's own components and CSS classes.

## Deviations this repo takes

1. **Rule 4 does not fire for text fields and dropdowns that already show their value.** The
   reasoning is in rule 4, together with the two situations that do trigger it.
2. **Rule 5 keeps "Control Shorthand recording" as a verb phrase.** The aloud test passes and
   the noun form drops the object.
3. **Rule 6 does not reach action buttons.** `Edit…` keeps its imperative, because a button
   invokes and an imperative is the right part of speech for that.
4. **Rule 1's "link to a docs page" target is `README.md` on GitHub, by absolute URL.** There
   is no hosted docs site. While this repository is private that link 404s for anyone without
   access; it becomes correct at publication, which is tracked separately and is out of scope
   for this spec. The alternative — inlining the paragraph — is the thing rule 1 exists to
   prevent, so the link stays.
5. **Error and status strings are out of scope for the nine rules.** `The profile could not be
   saved: ${message}` is failure text, not a setting description; it is governed by "name the
   thing that failed and the reason", and Task 46 leaves those strings alone except where they
   were plainly over-long.
