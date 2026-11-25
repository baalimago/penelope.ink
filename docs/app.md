# The app: what each control runs

This page is for contributors. It says what each control of Penelope runs on the machine, and how
the agent's runs, the AI providers, the notebook and the voice library fit together. For what a
user sees, read [`web/www/penelope-app.md`](../web/www/penelope-app.md), the app's reference that
Penelope herself reads. For the machine underneath, read [architecture.md](architecture.md).

The code's older name, Minutes, survives in storage keys (`minutes.*`, `minutes-*`), in
`minutes.js`, in names on the machine (`/tmp/minutes-stop-<n>`, `MINUTES_RUN`) and in the
notebook's commit messages.

## The desk and Penelope

The pointer is the system's, and the user's blue pen (`--pen-image` in `style.css`) over a text
field or a transcript's line. The same pen lies on the desk, at the foot of the sidebar: **Doodle**
picks it up (`web/www/sketch.js`, `body.doodling`), and while it is held the pointer is that pen and
a drag on the pad draws blue ink beside the pen's doodles, Ctrl+Z takes back the last stroke,
and **Put it down** or Escape puts it back. The ink stays on the page until the page turns. Going
to another meeting, run or New recording turns the yellow pad's page up over its binding
(`web/www/pageturn.js`).

Penelope is the red pen with a bow at the bottom right of the desk, and the app's icon. Her eyes
follow the pointer, and one that rests near her, but not on her or her bubble, she now and then
jumps at: one she reaches she eats, chewing it with puffed cheeks and a gulp while it is gone, one
beyond her reach she snaps at and misses (`penelope.js` `follow`, `pounce`). Her bubble grows out
of her, at its tail, and shrinks back into her when it closes. As the app arrives she pops up with
a guide to it, which leaves out the steps already done (an AI provider, slivingdoc). Her bubble is
one conversation for the session: she answers about the app, its screens and the meetings in the
notebook, told each time what the screen shows, and corrects the meeting in focus.

## Failure notes and run logs

Nothing the app does needs the peek under the hood; its buttons run programs on the machine
directly. When one fails, a note hangs under the peek button with what went wrong (clai's `error`
record: the provider's status and code, and clai's remedy when it has one) and a link that opens
the peek's terminal with the failure's lines selected. The note also names the command that
failed, its exit status and its last lines, and **Copy log** and **Download** hand out the job's
run log (`web/www/runlog.js`): each command and its exit status, what it printed, clai's
diagnostic, error and progress records, its tool calls and how they ended, its processes and its
notes, in time order. A log holds no model output (a reply, its deltas, a tool's result and a long
argument show as their length) and every secret the page holds is taken out. The agent's runs
start clai with `LOG_LEVEL=debug`; its debug records go to the log only, not to the terminal. The
peek's **Run logs** tab lists the logs of the newest ten runs, failed or clean, kept across reloads
in IndexedDB (`minutes-runlogs`). A tool that fails puts up no note: the agent goes on and handles
it, and the failure shows on the peek's terminal.

## What each control runs

| Button | Runs |
| --- | --- |
| Sign in with OpenRouter (Connect an AI provider) | nothing on the machine: OpenRouter's PKCE sign-in opens in a new tab, whose callback, `web/www/signin-callback.html`, hands the code back over a `BroadcastChannel`; the page trades it with its verifier at `POST https://openrouter.ai/api/v1/auth/keys` for a key that every run then gets as `OPENROUTER_API_KEY` |
| Use key (Connect an AI provider) | nothing on the machine: the pasted OpenAI key reaches every run as `OPENAI_API_KEY` |
| Disconnect (by the provider's chip) | nothing on the machine: the browser forgets the key. A key that a sign-in created stays live at its provider, so the card links to its page there (`https://openrouter.ai/keys/<sha256 of the key>`) to delete it |
| Start recording | `LOG_LEVEL=debug clai -json -reply-only -n -profile-path cchub:baalimago/meeting-transcriber#sha256=<hex> query '<notebook format>\n\nMeeting: <title>. <details>\n\n<inputs>'`, in `~/notebook`. `<notebook format>` (`notebookFormat`) names the two files and their front matter, and tells the agent to give the transcript only its front matter. The app files the transcript itself, word for word: `-af json` has `audio_transcribe` return its segments with their times, the app keeps the last result (`tool_result`, or the file clai saved it in when it passed the tool output limit, 21,600 characters), and when the run ends it writes one line per segment below the agent's front matter, `[0:12] Speaker A: …`, the words as they came (`writeTranscript`, `transcriptLines` in `proofread.js`). No model writes or rewrites a transcript line. `<inputs>` says what the checklist set up (`inputsToRecord`): the mic, `browser-mic`, and the computer's audio by its source, `browser-tab.monitor` or `browser-devN.monitor`, unless the user chose the mic only, so the agent never guesses them from the meeting's name. The people ticked under **Who is in the meeting?**, below the meeting's name (the voice library's people, pre-ticked with those who spoke in the last meeting of the same name), go on the line as `-voices 'Lorentz,Christoph'` beside `-af json` and end the query as `People: Lorentz, Christoph`, so `audio_transcribe` names only them by voice; with nobody ticked both are left out and the line is as it was, and clai tries every confirmed voice in the library. While this browser has trusted no version of the profile, the button reads **Trust the agent and start recording**, under a note that links to the profile on the hub, and runs `clai profiles trust` and then the agent. Before it starts clai, and once when the page loads, the app runs `clai config trust profile -check cchub:baalimago/meeting-transcriber`: when the hub has replaced the version this browser trusted (exit 3), nothing is started, the app forgets the old trust, and the button reads **Trust the agent and start recording** again. The run is pinned to the hash the check (or the trust) printed: clai cached those bytes as it checked them and reads a `#sha256=` from its cache, so a version the hub publishes between the check and the run never reaches the run, and the run fetches nothing. Every reply in the meeting (Send, Try again, Name the speakers) runs the same pin. `-n` stays as the backstop. With `-json` every line clai prints is a record (`web/www/agent.js` reads them): the app takes the reply from the `reply` records and draws every record on the console (`web/www/records.js`): what streams is joined into running text, a tool is a line with its result under it, progress redraws one line, and an error is red with its status, code and hint. |
| Stop and summarize | `: > /tmp/minutes-stop-<n>`, off the console like the run itself: the run's stop file, which clai's `audio_record` watches for (`CLAI_AUDIO_STOP_FILE`, in the run's environment), ends that recording with `stopped_because: stop_file`. Each run has its own, so Stop reaches the recording it belongs to whatever else runs, and nothing waits on the console after a recording that ended on its own |
| A run under **In progress** | nothing on the machine: the run's meeting view, with where it is and the time left, or what the agent said |
| pop out (by **In progress**, and beside Stop and summarize on a running meeting) | nothing on the machine: a small window that stays on top (Document Picture-in-Picture, Chrome and Microsoft Edge), with a row for each run under way: the recording's clock, wave and **Stop**, which touches its stop file as Stop and summarize does, then the phase, hatching and time left, then how the run ended. A click on a row brings the tab back with that meeting. Chrome also opens it on its own when the user switches tabs while the mic records (its automatic picture-in-picture, the media session's `enterpictureinpicture` action), and closes that one when the tab shows again; it does so only for an https page (the site on Wasmer Edge, not http://localhost) and only in a browser window with tabs, never in the installed app's window. Every browser gets the run in the tab's title and icon (`● 12:34`, `3 min left`, `✓ Filed`), and a run that ends while the tab is hidden or out of focus sends a system notification |
| Before you record (a checklist on a post-it) | **Allow the mic** asks for the microphone; **Share a tab with your call** asks for a screen or tab, whose audio is the sink `browser-tab` until the share stops; the page then listens to it and ticks **Sound heard** once sound comes through. Start recording waits for the mic and the share (or **record the mic only**), not for sound, so a recording can start before anyone speaks. While it records a shared tab, a minute with no sound from it (`QUIET_MS`, `AudioInputs.followShare`) puts up **Are you sharing the right tab?** on the page, in its title and as a system notification, whose permission Start recording asks for (notifications also say that a run ended while the tab was hidden) |
| Send (answer the agent) | the same `clai` as `clai -json chat continue -reply-only -n [-voices '<people>'] -profile-path <pin> <flags> '<id>' '<answer>'`, `<people>` those its meeting started with. `<id>` is the conversation clai saved the answered run in, which its `chat` record names (`AgentRun.chat`, kept on the job); `chat continue` sends to that conversation, never to the one `~/notebook` is bound to, which would be whichever run there ended last: another meeting's when several run at once. `<pin>` is the version the meeting started with: no check, no fetch, nothing to refuse. When the app knows the hub has a newer version, a note says **This meeting keeps the agent it started with**. A run that stopped before clai saved a conversation leaves none, and then the meeting starts again with the answer as its details |
| Name the speakers (under **Who is speaking?**) | no agent: each label becomes its name wherever it stands whole in both files (`named` in `proofread.js`), as corrections, which then save as Save does. Each speaker's row has a line of theirs (`unknownSpeakers`: one of four words or more, with its stretch of the recording, to its end or the next line's start, at most 10 s), whose ▸ time plays that stretch from the recording this browser kept (`Proofreader.playSpan`), to hear who it is. Above the labels, a name the library gave says so, and a voice the agent learned in this meeting offers **Keep** (`web/www/review.js`). With **Remember these voices** ticked, each speaker label you name adds a confirmed clip of that speaker to the library: the recording goes back on the machine as Transcribe again puts it, then `clai audio transcribe voices add /tmp/recordings/again-<meeting>.wav -from <s> -to <s> -name <name>`, the speaker's longest stretch of 3–10 s; the names are saved whether or not the library took the clip |
| Keep (a voice the agent learned, under **Who is speaking?**) | `clai audio transcribe voices list <person> <clip> confirm </dev/null`: the clip stays in the library as one the user stands behind, and its row goes |
| Not `<name>`? (a name the library gave, under **Who is speaking?**) | `clai audio transcribe voices list <person> <clip> overrule </dev/null` for the clip that named the speaker, then, only when it succeeds, the name typed replaces `<name>` in both files, saved as Name the speakers does. A command that fails says its first line above the rows and on the terminal, and renames nothing |
| Try again with this recording | the same `clai` in a new conversation on the meeting's version, with the `-voices` and `People:` of the run it tries again, told the recording's file and not to record again; Send then goes on with that conversation |
| A meeting | `cat` of its summary and transcript: the summary rendered as markdown, the transcript one row per utterance (`web/www/proofread.js`) |
| The meeting's title (click, or Enter on it) | nothing at once: the title becomes a field, and Enter or leaving it rewrites `title:` in both notes' front matter (`retitled`) as one correction step on the post-it, which then saves as Save does. The files keep their names |
| The recording, at the top of a meeting (play, the wave, Download the recording) | nothing on the machine: the WAV this browser keeps for the meeting (IndexedDB, under its summary's path; the notebook holds text only, so only a meeting recorded in this browser has one). Its wave is sketched in pencil and inked in red pen as it plays (`web/www/player.js`); the wave is the seek, where the arrows move 5 s and Space plays. **Download the recording** saves it as `<title>-<yyyy-mm-dd>.wav` |
| The eraser (at the top of a meeting) | first a post-it asks, saying what goes: **Delete it** or **Keep the meeting**. Then `rm -f <summary> <transcript>` in `~/notebook`, with the recording where a run of this tab or Transcribe again left it on the machine; with slivingdoc, `slivingdoc commit -m 'Minutes: deleted <title>'`, so the notes stay in the notebook's history, and a commit that fails puts both files back and deletes nothing else. Then this browser forgets the meeting: its notes (`minutes-notebook`), its recording (`minutes`) and its kept segments (`minutes-segments`), which no history keeps. Unsaved corrections go with it. The voice library keeps the clips the meeting taught it. The eraser is away while a run is about the meeting (`canDelete`, `deleteMeeting` in `minutes.js`) |
| Transcribe again (under the recording) | first a post-it asks: the agent's new notes replace the corrections; with slivingdoc this version stays in the notebook's history, without it it is gone. Then the recording goes back on the machine, which keeps no file past a reload, as `/tmp/recordings/again-<meeting>.wav`, in parts of 1.2 MB, each `printf %s "$1" \| base64 -d >> <file>` (a run's arguments hold 2 MiB in all); then the same `clai` in a new conversation on the newest version trusted, with `-voices` and `People:` naming the people the meeting's kept segments named, told that file, not to record again, and to write the new summary over the meeting's; the app then files the new transcript as at Start recording; with slivingdoc, `slivingdoc commit -m 'Minutes: <title>, transcribed again'`. The old notes fade while it runs |
| A line of the transcript, its speaker, its time | nothing yet: a click on the words corrects them in place, one on the speaker reassigns the line, and one on the time plays the line from the recording this browser kept. A correction is struck in red pen and written in in blue, and a post-it counts them; a word or name fixed once is offered **everywhere** it is in the transcript and the summary |
| Penelope, the red pen at the bottom right (Ask, in her bubble) | `printf %s "$1" > /tmp/penelope/profile.json`, her UI reference `web/www/penelope-app.md` as `app.md` and, with a meeting in focus, copies of its files as they read now, with the unsaved corrections, into her desk `/tmp/penelope/desk/`; then there `clai -json -reply-only -profile-path /tmp/penelope/profile.json query '<INPUT>'`, with `-dre` from the second question on, so the one conversation goes on whatever is in focus. The profile is `web/www/penelope.json`, with every tool; the INPUT holds what the screen shows (the meeting in focus, the runs in progress, the connections, the headings and buttons showing), the corrections and the question (`web/www/penelope.js`, `penelopeScreen` in `minutes.js`). She reads the notebook in `~/notebook/meetings` and writes only the copies. The INPUT also lists the actions the app can take for her now (`penelopeActions`): pressing **Transcribe again** or **New recording** while that button shows, opening a filed meeting, and deleting filed meetings (`delete_meeting`, one action a meeting: her bubble asks once for all of them, and a yes deletes each as the eraser does, `penelopeDelete`); the `do` of her answer names the ones to take, which the app takes once her answer shows, as the button would, so the user still confirms what it asks. The app reads the copies back and shows each line she changed, added or took out as a correction in pen, one step that **Undo these** takes back; her answer is the JSON object her prompt asks for, whose `mood` sets her face |
| + Tools, in Penelope's bubble (beta): tick Linear | nothing on the machine for the sign-in, which is OAuth in the page (`web/www/connections.js`): the server's protected-resource and authorization-server documents (`https://mcp.linear.app/.well-known/...`), a client registered once per browser (`POST /register`, public, with `signin-callback.html` as its redirect), Linear's sign-in page in a new tab with PKCE and the `resource`, and the code traded at `POST /token`. Its tokens become clai's own token store entry for the server (`issuer`, `resource`, `client_id`, `access_token`, `refresh_token`, `expires_at`, `scopes`), kept in the browser with the server attached. Then each Ask adds `"linear": {"url": "https://mcp.linear.app/mcp", "optional": true}` to her profile's `mcp_servers`, no `auth` block, and writes the entry where clai reads it, `printf %s "$N" > "$(clai confdir)/mcpAuth/<sha256 of linear>.json"`; clai sends it and refreshes it, and after the run the app reads the file back and keeps what clai wrote. Untick detaches it (her profile leaves it out); **Sign out** forgets the sign-in and revokes its refresh token at the server's `revocation_endpoint`, saying so when the server does not confirm. Each browser signs in on its own, since clai's token store does not sync and two clients sharing one refresh token break each other |
| Save (on the corrections' post-it) | `printf %s "$1" > <summary>` and the same for the transcript, the corrected files reaching bash as its arguments, each correction placed by its line's text in the file as it is now; then, with slivingdoc, `slivingdoc commit -m 'Minutes: corrections to <title>'`. A commit that fails puts the files back; one that conflicts keeps the other side's lines and commits again, so no conflict block stays in the notebook. Leaving the meeting waits until the corrections are saved or dropped |
| history | `slivingdoc log` |
| Sign out | `slivingdoc logout`: the site revokes the key and the login is forgotten, here and on the machine |

## The agent and the AI providers

The agent is the whole transcriber: it records (its `audio_record` tool starts ffmpeg), transcribes
with speaker labels, and files the notes. It is clai run with the `meeting-transcriber` profile
from the clai hub (`cchub:baalimago/meeting-transcriber`, source in
[`web/profiles/meeting-transcriber.json`](../web/profiles/meeting-transcriber.json)). Penelope is
clai run with [`web/www/penelope.json`](../web/www/penelope.json).

Both need an AI provider, and `web/www/providers.js` lists them: how each is connected (a pasted
key or an OAuth sign-in), the variable its key reaches clai as, and the models the agents run with
on it. The provider card stays on the pad until one is connected, so the user connects one at a
time, and **Disconnect** brings the card back. Should two keys be set anyway (an `export` in the
terminal), the first in the list, OpenAI, is used.

| Provider | Connected by | Key reaches clai as | Models |
| --- | --- | --- | --- |
| OpenAI | a pasted API key | `OPENAI_API_KEY` | the profiles' own: the agent chats with `cchub:baalimago/cheap@1` (a model list on the clai hub) and transcribes with `gpt-4o-transcribe-diarize`; Penelope chats with `gpt-6.1-sol` |
| OpenRouter | Sign in with OpenRouter (PKCE) | `OPENROUTER_API_KEY` | the agent gets `-cm 'or:openai/gpt-5.6-luna' -am 'or:elevenlabs/scribe-v2+diarize'` (`+diarize` asks for speaker labels), Penelope `-cm 'or:openai/gpt-6.1-sol'`; these override the profiles' models |

The app only puts the notebook's layout (`meetings/summaries/<start>_<slug>.md` and
`meetings/transcripts/...`) at the top of the query, so the profile stays as it is. When the agent
is done, the meeting it filed opens as Summary and Transcript cards; what it says shows as markdown
(`marked`, with raw HTML shown as text and links to the notebook's files opening them in the app).

## The notebook

Without a slivingdoc token the notes are written in `~/notebook` on the tab's machine, which keeps no
file past a reload, so the app keeps each filed or saved meeting's summary and transcript in this
browser (IndexedDB `minutes-notebook`, `web/www/notebookkeeper.js`) and puts them back on the
machine at each load, before it lists the notebook. Clearing the site's data removes them, and no
other browser sees them. The query then tells the agent not to use slivingdoc, so the profile's slivingdoc
server, which would sign in only on a first tool call, is never asked to.

With a token (a sign-in at slivingdoc.dev or a pasted token, under Connect slivingdoc), every run
gets `SLIVINGDOC_TOKEN`, and `~/notebook` is a local copy of the hosted notebook: the meeting list
pulls it first, the agent writes its files there through its slivingdoc server (which may commit
them itself), and the end of each run, Save and Transcribe again run `slivingdoc commit`, which
publishes them and keeps the notebook's history.

When an agent run ends, the app first takes the recording off the machine into IndexedDB, whatever
became of the run, so a failed transcription or a reload cannot lose it. It then files the
transcript from the transcription's segments (`writeTranscript`), and with slivingdoc commits
what the run filed (`slivingdoc commit -m 'Minutes: <title>'`). The recording is then kept under
the meeting's summary path. The notebook holds text only, so a recording whose notes are gone stays
in IndexedDB but is no longer listed; the eraser at a meeting's head deletes the notes and the
recording together.

The agent's trust in its hub profile is kept in local storage (`minutes.clai-trust`) and written
back into clai's config on the machine at each load; the slivingdoc login is restored the same
way, and the AI provider's key is handed to each run. clai's conversations are not: they live on the machine only, so after a reload
Send starts the meeting again with the answer as its details.

Sign out revokes the key at the site before the app forgets it; when that fails the login
stays, with the CLI's last line and the Tokens page to revoke it by hand, because a live key must
not be orphaned silently.

## Runs in the background, and the time left

The agent's runs (Start recording, Send, Try again, Transcribe again, Penelope) go on in the
background, beside each other and the app's other lines, which still take turns: a meeting can
be transcribed while another is recorded, and the app is free to open other meetings meanwhile.
One meeting records at a time. Each run is listed under **In progress** with where it is and the
time left, which a ballpoint pen draws as a box it hatches in (`web/www/jobs.js`, `doodles.js`); around it the pen scribbles what that run's processes did, and only that run's, on a page of its own for each run in view. The
time left is estimated phase by phase from the recording's length (`duration_seconds` in
`audio_record`'s result, else the recording ffmpeg's start and end), clai's `audio_transcribe`
progress records, and the transcript's length once it is back. clai
reports every transcription (its architecture/audio.md, Progress): one request is a status that
names its size, says when the page's ffmpeg encodes the recording first, and, where the provider
streams its segments (OpenAI's diarize model), how far it has heard (`heard 4:10`), which the
stages show and which re-bases the time left; a split recording has a row per chunk, whose pace
sets the rest's. A recording past one OpenAI request (1,400 s) goes clai's survey path, whose parts
all run at once: its time is three rounds of one part (survey, labelling, a second try, each with
88 s of voice clips in front), about 65 s per merge link between parts, and about 75 s of naming.
clai's steps (finding the voices, matching them, labelling, the second try, stitching) each leave
only what comes after them, and the first round's own time paces the rounds left. The first pace of a transcription is measured per provider (2026-11-16, 20 s and
80 s of speech, upload excluded: OpenAI `gpt-4o-transcribe-diarize` 2.9 s + 22.5 s an audio
minute, OpenRouter `elevenlabs/scribe-v2` 1.2 s + 1.9 s), plus the upload of the 16 kHz WAV
(1.92 MB a minute) at an assumed 1 MB/s; the page's fetch carries the upload and shows clai no
progress of it, so the user's own runs correct it: each phase's pace is learned from the runs
that filed a meeting, per provider, and kept in the browser (`minutes.pace.3`; a survey run teaches the round, the merge link and the naming). A phase past its
estimate says so ("Taking longer than expected, then about 3 min") rather than a number that
would stand still; the hatching creeps on, and the list's clock ticks. The runs in the background are not on the
machine's console: the page starts them as services (`Shell::spawn`, wasixv2's `Attach::Stdio`),
whose input is `/dev/null` and whose output shows on the terminal, with no controlling terminal.
The console stays the peek's terminal's and the app's own lines', which take turns on it as a
login's do, so a line run there has it as its controlling terminal (`/dev/tty` works), reads what
is typed, and dies of `^C`; no background run reads it, takes it, or hangs it up as it ends
(wasixv2's `disassociate_ctty`). Each run's records reach the page under its own topic,
`agent:<n>`, from `MINUTES_RUN` in its environment.

## The voice library

The voice library is clai's: short clips of each person's voice, which a transcription uses to put
names in place of speaker labels (clai's
`architecture/audio.md`, Known voices). The user shapes
it from **Who is speaking?**: **Remember these voices** adds a confirmed clip of each speaker
label named; the agent's `audio_remember_voice` tool adds clips that stay unconfirmed until the
user presses **Keep**; and **Not `<name>`?** tells the library a clip named the wrong person.

A transcription names the people ticked under **Who is in the meeting?** on New recording, or, with
nobody ticked, everyone with a confirmed clip. After the provider has transcribed the recording
with speaker labels, clai sends those people's clips beside one clip of each transcript speaker to
the same transcription model, in two naming requests with the clips in opposite orders, and a
speaker takes a person's name only when both agree. A speaker nobody matches keeps its label, and
a failed naming never fails the transcription.

The library lives in this browser: clai's `voices/` (each person's `voice.json`, clips and
`events.jsonl`) is kept in IndexedDB (`minutes-voices`, `web/www/voicekeeper.js`), and each
transcribed meeting's segments, naming report and the clips its runs learned are kept by its summary's
path (`minutes-segments`, `web/www/segmentkeeper.js`). Before every agent run and every `voices`
command the app puts the library on the machine under `$(clai confdir)/voices/`, adding only what is
missing; after it, it takes back what the run wrote. With an empty library nothing is put. Clip audio
is stored only in IndexedDB and on the machine; it leaves the browser only inside the naming
requests clai sends to the AI provider during a transcription. A library that cannot be put or
taken back is a line on the terminal, not a note.
