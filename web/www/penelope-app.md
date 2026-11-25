# The Penelope app

Penelope records meetings in the browser, then an AI agent (clai, with the meeting-transcriber
profile from the clai hub) transcribes them with speaker labels, writes a summary and files both
in the notebook. It all runs on a small Linux machine (WASIX) inside the browser tab. It needs
Chrome or Edge 137 or later on a computer; Firefox and Safari cannot run the machine.

## The layout

- Top bar: **Penelope** with her icon; chips for the machine ("wasmer.sh · WASIX v2 kernel"), the
  notebook ("slivingdoc: …") and the AI provider ("AI provider: …", with **Disconnect** once one
  is connected); **Peek under the hood** on the right.
- Left sidebar: **New recording**; **In progress**, the runs under way, with **pop out**; the
  meetings in the notebook, by day. At its foot, where the notes are kept ("Notebook: …",
  `~/notebook/meetings/`) and **Connect slivingdoc** or **Sign out**, then the link
  the button **Install Penelope as an app**, which opens the browser's own prompt to install the web
  app beside the native ones (Chrome and Edge, on a computer or Android; hidden in the installed app
  and where the browser offers nothing), then the link
  **Penelope is open source: read the code, or run your own** to the app's source code on GitHub
  (https://github.com/baalimago/penelope.ink, MIT-licensed; its README says how to run it locally
  or host your own copy); above that, the user's blue pen
  with **Doodle**.
- The pad, in the middle: the screen in use, New recording or a meeting.
- Penelope, the red pen with a pink bow, at the bottom right: a click opens her bubble.
- Right after the page opens, the sidebar shows a load bar: the app shows at once, and the
  machine's programs are still coming in. It says how much has come and what is not ready yet
  (the machine, Penelope, recording, the other tools), and it goes once everything is in.
  A control that needs what is still loading is pale with "…" and waits when clicked, and
  **Start recording** reads **Getting ready to record…** until a recording can run. If a
  program fails to load, the bar says which and offers **Try again**.

## Getting started

- **Connect an AI provider**, a card on the pad until one is connected. It does the transcribing
  and the writing, billed to the user's own account.
  - **Sign in with OpenRouter** opens OpenRouter in a new tab; approving there brings a key back.
  - Or paste an OpenAI API key and press **Use key**; a restricted key with a small budget is safest.
  - The key stays in this browser and reaches only the agent. **Disconnect** forgets it; a key
    that a sign-in made stays live at OpenRouter until deleted there (the card links to it).
- slivingdoc, the hosted notebook, on a sticky note ("First, sign in to slivingdoc"). Notes kept
  there outlive this browser.
  - **Sign in to slivingdoc** (in a new tab), or paste an API token from
    https://www.slivingdoc.dev/tokens and press **Use token**.
  - **Not now, keep notes in this browser** keeps them in this browser only: they outlive a reload,
    but not clearing the site's data, and no other browser sees them.
  - A login that reaches several spaces asks for one: **Use this space**.
  - **Connect slivingdoc** and **Sign out** are in the sidebar.

## Recording a meeting (New recording)

- **Meeting name**, and "Who is there, and anything else the agent should know".
- "Who is in the meeting?": a box for each person whose voice this browser's library holds, shown
  once it holds one. Typing a meeting name ticks the people who spoke in the last meeting of that
  name; the user ticks or unticks the rest. Ticking narrows the naming to those people: the
  transcript names them by their voice. With nobody ticked, every confirmed voice in the library is
  tried.
- The post-it "Before you record":
  - **Allow the mic**.
  - **Share a tab with your call**: pick the call's tab or screen, with its audio shared.
  - **Hear the call's sound** ticks itself once sound comes through.
  - **Or skip it: record the mic only**, for a meeting in the room. **Stop sharing** ends the share.
- **Start recording** waits for the checklist. It records what the checklist set up: the mic, and
  the computer's audio unless the user chose the mic only. The first start trusts the agent's hub
  profile in this browser ("read what it runs" shows it).
- While it records, the meeting shows the clock, a sound wave and the inputs, with
  **Stop and summarize** and **pop out**. "Are you sharing the right tab?" shows when the shared
  tab has been silent for a minute; the recording goes on.
- **Stop and summarize** ends the recording. The agent transcribes, summarizes and files the
  meeting; the time left shows, and the pencil hatches a box as it goes.
- One meeting records at a time; others can be transcribed meanwhile.

## While a run works

- **In progress** lists each run with its phase and time left; a click opens it.
- **pop out** opens a small window that stays on top of other windows, a row per run: the
  recording's clock, wave and **Stop**, then the phase and time left, then how it ended. A click
  on a row brings the tab back with that meeting. Chrome also opens it by itself on a tab switch
  while recording, but only on the https site and in a browser tab, not in the installed app.
- The tab's title and icon show the status ("● 12:34", "3 min left", "✓ Filed"). A run that ends
  while the tab is out of sight sends a system notification.
- "The agent says" shows what the agent answered or asks; answer it and press **Send**.
- A run that failed offers **Try again with this recording**: the recording is kept in this browser,
  in the player above.
- "Who is speaking?": name the speaker labels (Speaker A, …) and press **Name the speakers**; the
  app puts each name in place of its label in the transcript and the summary, and saves them. With
  the recording kept in this browser, each speaker's ▸ time plays a line of theirs, to hear who it is.
  - A name the voice library gave says "named by the library", from a confirmed or an unconfirmed
    clip. **Not <name>?** takes the right name: the library learns that clip was wrong, then the
    name is changed in both files and saved.
  - A voice the agent learned in this meeting says so, with **Keep**: the library keeps that clip
    as one the user stands behind.
  - **Remember these voices**, ticked before **Name the speakers**, adds a clip of each speaker
    named to the library, so later transcripts name them.
  - What the library could not do (a clip refused, a correction it did not take) shows as a line
    above the rows, never as a note.

## A filed meeting

- The title and date, then the recording, then the **Summary** and the **Transcript**: one row per
  utterance, its time, its speaker and its words. The transcript is the transcription word for
  word, as the speech-to-text model heard it; the agent writes only the summary.
- The recording shows only for a meeting recorded in this browser, which keeps it; the notebook
  holds text only.
  - A red circle plays and pauses it; the pencil waveform beside it seeks (a click, the arrow keys
    5 s at a time, Home and End), the played part turning red; then the time, "0:03 of 0:09".
  - **Download the recording (… MB)** saves it as a WAV named for the meeting and its day.
  - **Transcribe again** has the agent transcribe the recording again and write a new summary and
    transcript in place of these. A post-it asks first: **Transcribe again** or
    **Keep these notes**. The user's corrections are replaced; signed in to slivingdoc the old
    version stays in the notebook's history there, while a notebook kept in this browser keeps none.
    It runs like any other run, under **In progress**.
- Correcting the transcript:
  - A click on the words corrects them in place; on the speaker, reassigns the line; on the time,
    plays the line from the recording this browser kept.
  - Keys: Enter corrects, Space plays, S changes the speaker, the arrows move between lines.
  - A correction shows struck in red pen and written in blue.
  - Fixing a name offers the same fix elsewhere: **Fix them all** or **Just this one**.
- Renaming the meeting: a click on its title (or Enter on it) makes it a field; Enter or leaving it
  renames the meeting in both notes' front matter, Escape keeps the name. The rename is a correction
  on the post-it (two: one in each note), saved, undone or dropped with the others. The file names
  stay as they are.
- Deleting the meeting: the eraser at the top right of the meeting, beside its title. A post-it asks
  first: **Delete it** or **Keep the meeting**. Deleting takes the summary and the transcript out of
  the notebook and erases the recording this browser keeps, with any unsaved corrections. Signed in
  to slivingdoc the notes stay in the notebook's history there; the recording, and a notebook kept
  in this browser, are gone for good. The eraser is away while a run works on the meeting. Penelope
  can delete meetings too, several at once: she asks in her bubble first.
- The corrections post-it counts them: **Save** files them in the notebook, **Undo the last**,
  **Drop them**.
- "Saved to the notebook as …": the meeting's files in the notebook.

## Penelope

- She is on the desk from the start, and her bubble opens with a guide to the app.
- Her eyes follow the pointer. The pointer is the usual arrow; over a text field, or a line of a
  transcript to correct, it is the user's blue pen.
- The user's blue pen also lies on the desk, at the foot of the sidebar. **Doodle** picks it up: the
  pointer becomes the pen, and dragging on the pad draws in blue ink, beside the pencil's own
  doodles; Ctrl+Z takes back the last stroke. **Put it down**, or Escape, puts it back, and the pad's
  buttons work again. The ink stays on the page until the user goes to another page.
- Rest the pointer near her and she may jump at it, chew it up and gulp it down (it comes back); one
  out of her reach she snaps at and misses.
- With a meeting open she can correct it: what she changes shows in pen, to keep with **Save** or
  take back with **Undo these**. With none open she answers about the app and the notebook.
- She can have the app transcribe the open meeting again, open a meeting, or show New recording,
  each as its own button would; the user confirms what that button asks.
- She can delete filed meetings, the open one or others, to tidy the notebook: her bubble asks once
  for all of them, **Delete it** or **Keep it** (**Delete all 3**, **Keep them**), and a yes deletes
  each as the eraser would. Asking her something else instead keeps them.
- She needs a connected AI provider.
- **+ Tools** (beta), left of her Ask box, lets her use the user's own services. Linear is the
  first: ticking it opens Linear's sign-in in a new tab, and once the user approves Penelope there,
  Linear is attached and the button shows its name. She can then read and, when the user agrees,
  create or change their issues. Unticking detaches it; **Sign out** forgets the sign-in in this
  browser and asks Linear to revoke it. Each browser signs in on its own.

## Under the hood

- **Peek under the hood** opens the machine below the app: **Activity** (what each click started,
  opened and connected to), **Network and files**, **Terminal**, and **Run logs**.
- A step that fails leaves a note under the peek button. It names the command that failed, its exit
  status and the last lines it printed, with a link to its lines in the terminal, and **Copy log** and
  **Download** hand out the run's log: what the run did, with no secrets and none of the model's words.
- **Run logs** lists the logs of the last ten runs, failed or clean, each with **Copy** and **Download**.

## The app on the desktop

- Chrome and Edge install it as an app in its own window: the install button in the address bar,
  or the browser's menu. It loads from the site each time and needs the network.
