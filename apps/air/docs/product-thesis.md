# Base Air: Product Thesis

*v1, 2026-11-01. Companion to `social-command-center-plan.md`, which holds the API constraints, stack, and schema. This document is the "what and why" that the plan should now serve.*

---

## 0. In one sentence

**The system of record for a brand's attention: it observes every surface where attention forms, forecasts where it is going, acts through agents inside the brand's own red lines, and proves what actually moved the outcome. It gets smarter with every brand on it.**

Hootsuite is a publishing tool. Sprinklr is a workflow suite. Google Analytics was a measurement product. None of them is an operating system for attention itself. That is the gap, and it is wide open because the incumbents are organized around the thing that is disappearing: a human at a keyboard, per seat, per channel.

---

## 1. The reframe

Stop thinking "social media management." Three facts make that frame obsolete.

**Attention no longer lives in feeds alone.** It forms in TikTok and Instagram, yes, but also in Google, in ChatGPT and Perplexity answers, in creator videos, in Discord servers and subreddits, in newsletters and podcasts. A brand that measures only its own social posts is measuring the wake, not the ship.

**Posting is becoming free.** Any agent can draft and schedule. Within a year, every brand will have an agent that posts. The scarce skill shifts from "publishing well" to "knowing what to publish, when, where, and whether it worked."

**Platform data is closing.** Reddit's public API dies in March 2027. X is metered. Meta and TikTok gate everything. The ability to observe attention broadly is becoming a licensed privilege, and the longitudinal record of it is becoming irreplaceable.

So the product is not a better cockpit. It is the institution that **observes, forecasts, acts, and proves** across all of it, and whose knowledge compounds.

The right mental model is closer to a Bloomberg terminal plus a trading desk than to a scheduler: attention is the market, topics and audiences are the instruments, every post is a position, and the system's value is the quality of its information and the discipline of its execution.

---

## 2. The five systems

Everything the product does belongs to one of five systems. They share one data spine (the event store and ledger from the plan) and one policy spine (red lines, autonomy levels, approvals).

### 2.1 The Attention Graph (observe and forecast)

A living model of **topics, audiences, creators, and channels**, and how attention flows between them over time.

- **Ingest** everything licensed and open: connected social accounts, Google Trends (alpha), YouTube trending, Bluesky firehose, Wikipedia pageviews, news, podcast and newsletter signals, licensed Reddit where obtainable, AI-answer sampling, and the brand's own site and email data. Every raw payload stored immutably.
- **Cluster** raw signals into named topics using Claude, with the brand's context deciding what counts as relevant.
- **Forecast**, not just report. Every topic gets a projected attention curve with a confidence band: rising, peaking, fading, with time-to-peak estimates. The confidence band is honest: narrow where sources agree and data is dense, wide where it is thin. Users learn to trust it because it never pretends.
- **Position** each brand on each topic: how much of the conversation it owns, how its share is moving, who else is taking it.
- **Cross-brand priors.** With consent and anonymization, the graph learns from every brand on the platform. Topic lifecycle shapes, channel decay curves, format performance by vertical. One brand's data is noisy; a hundred brands' data is a forecasting edge no single agency can build. This is the network effect.

What the user sees: a radar, not a list. Topics as instruments with sparklines and bands. "Act now" windows. The question answered is "where will attention be in 72 hours, and can we be there first?"

### 2.2 The Outcome Engine (measure causally)

Dashboards tell you what happened. The best product tells you **what caused it** and **what to do differently**.

- **The ledger.** Every post recorded with its full context at publish time: topic and stage on the curve, channel variant, timing, format, creative features, approver edits, policy state. Then outcome snapshots at 1h, 6h, 24h, 72h, 7d, 30d. Plus downstream: link clicks, site events, conversions, mentions, follower delta, AI-answer citations.
- **Experiments by default.** Any post can be an experiment. Variants across channel, time, hook, format. Holdouts by geography or audience where the platform allows. The system proposes the experiment design, runs it, and reads the result with proper uncertainty.
- **Incrementality, not vanity.** Synthetic controls and matched baselines to answer "what would have happened without this?" The old Google Analytics promise was attribution. The modern fulfillment is incrementality across attention surfaces.
- **Explanations with evidence.** Every insight carries its receipts: the posts, the curves, the comparison set. Nothing is a black box.
- **Per-brand learned models.** Best time, best format, best topic stage, best channel mix, all learned from that brand's own ledger and sharpened by cross-brand priors.

What the user sees: an answer, not a chart. "Posting on this topic at the rising stage on TikTok and LinkedIn within 24 hours produced 3.1x the engagement of your baseline, with 80% confidence. The same topic at peak produced 0.9x. Here are the 14 posts behind that."

### 2.3 The Operators (act, inside red lines)

Agents that run continuously, with a human setting policy rather than pushing buttons.

- **Roles, not features.** A Watch operator (monitors the graph and the feed, raises alerts), a Studio operator (drafts on-voice content for windows the Watch finds), a Desk operator (handles replies, comments, DMs, escalates), an Analyst operator (reads the ledger, writes the weekly brief, proposes experiments), a Steward operator (checks every outgoing item against red lines and disclosure policy).
- **Red lines.** Each brand declares constraints it never crosses: topics it does not touch, claims it never makes, tones it avoids, competitors it does not name, times it never posts, legal and regulatory limits. Red lines are enforced on every output, from every operator and every human, and every enforcement is logged. A declared red line is a credibility contract: the system holds it even when a human is tempted.
- **Autonomy dial per brand and per action class.** Suggest, draft, schedule-with-approval, autopost. A new brand starts conservative; trust is earned through the ledger and the dial moves. Replies to routine comments may be autonomous while new campaign posts always need a human.
- **Full accountability.** Every operator action is an event: what it saw, what it decided, why, what policy applied, who approved. Reversible where the platform allows. Exportable always.
- **Agent-addressable.** The whole system is exposed as MCP tools. A marketer in Claude or ChatGPT says "what should we post about this week for Client X?" and the answer comes from the graph and the ledger, and the resulting post lands in Client X's approval queue with its provenance intact. The product is infrastructure for whatever agent the user prefers.

What the user sees: a morning brief, a queue of proposals with evidence, a small number of decisions to make, and a log that lets them sleep.

### 2.4 The Studio (create with voice and provenance)

Creation is not the moat, but doing it badly loses the user. The Studio makes the right thing the easy thing.

- **Voice as a living model.** Brand voice is not a style guide PDF. It is examples, rules, and the full history of what humans changed in agent drafts, embedded and retrieved on every generation. The diff between draft and published is the training signal.
- **Native per channel.** One idea, adapted to each surface's grammar: hook structure, length, hashtag norms, media specs, thread or carousel logic. Previews that are pixel-faithful.
- **Media pipeline.** Transcode, caption, transcribe, thumbnail, and sign. Every exported asset carries C2PA Content Credentials and an internal disclosure record (what was AI-assisted, what was human, who approved). When TikTok or LinkedIn display credentials, the brand is ahead; when a regulator asks, the record exists.
- **Experiment-aware composition.** The composer knows when a post is a variant and what hypothesis it tests.

### 2.5 The Network (compound across brands and agencies)

This is what turns a tool into a platform and makes year five better than year one.

- **Benchmarks.** Anonymized, consented, by vertical and channel. "Your engagement on rising-stage topics is in the 71st percentile of consumer brands this size." Only scale produces this.
- **Playbooks.** A playbook is a strategy encoded as policy plus operator configuration plus the ledger evidence that it works. Agencies build playbooks, prove them on the ledger, and share or sell them. A marketplace of proven strategies is a content moat and a network effect at once.
- **Agency distribution.** Agencies are the channel. White-label reports, multi-client command, per-client billing, and a partner tier where agencies' own playbooks earn them revenue. Each agency brings many brands; many brands sharpen the graph for everyone.
- **Open event schema.** Publish the ledger and attention-event schema as an open specification, the way Segment did for product analytics events. Other tools can emit into it, and the product becomes the natural place the data accumulates. Formats open, gravity proprietary.

---

## 3. Why it would be the best

Ten principles that are the product's character, not its feature list.

1. **Estimates with confidence bands, never false precision.** The system shows how sure it is. Users calibrate on it and come to trust it.
2. **Every recommendation shows its evidence.** Click any claim and see the posts and curves behind it.
3. **Forecast first, report second.** The question is always "what's next," with "what happened" as the proof.
4. **Policy over buttons.** The human sets red lines and autonomy; operators do the work; the ledger holds everyone accountable.
5. **One room, no page-flipping.** The graph, the feed, the queue, and the brief live on one screen. Detail opens as drawers over the room, not as separate pages. Dense, legible, calm.
6. **Honest about platforms.** When a platform gates or meters, the product says so and shows the cost. No silent degradation.
7. **Provenance by default.** Signed media, disclosure records, audit logs. Trust is a feature.
8. **Portable by design.** Full export, open schema. Users stay because it's better, not because they're trapped.
9. **Learns from every correction.** Every edit, rejection, and approval sharpens the brand's model. The product should feel noticeably smarter at month three than at week one, and say so.
10. **Model-agnostic, data-loyal.** The LLM is a component behind a gateway with evals. The data spine is the product.

What it feels like over time:

- **Day one:** connect accounts, declare three red lines, pick an autonomy level. Within an hour the radar shows topics with bands and the Watch operator has flagged two windows. The Studio has drafts in the queue with evidence attached.
- **Month three:** the Analyst's weekly brief is quoting the brand's own ledger. Forecasts for the brand's core topics have visibly tightened. The autonomy dial has moved up on replies. The first experiment has a result.
- **Year two:** benchmarks place the brand against its vertical. Two playbooks from other agencies are running and paying. The brand's agent in Claude is doing most of the routine work, and the human's job is strategy and taste.

---

## 4. The moat, power by power

Using Helmer's seven powers, because "moat" should mean something specific. Durability estimate is how long each power holds without further investment.

| Power | How this product has it | Durability |
|---|---|---|
| **Cornered resource** | The longitudinal, normalized, cross-surface attention record captured while sources were still open (Reddit closes 2027). Platform approvals (Meta Advanced Access, TikTok audit, LinkedIn CMP, Google Trends alpha, any Reddit license) are themselves scarce resources once held. | Strong and growing. Nobody can rebuild 2026–2027 data in 2029. |
| **Network economies** | Cross-brand priors make every forecast better as brands join. Benchmarks exist only at scale. Playbook marketplace gains value with participants. Agencies bring brands; brands improve the graph for agencies. | Weak at 10 brands, strong at 1,000. This is the power to invest toward. |
| **Switching costs** | The brand's context graph (voice, red lines, approvals, learned models) and its ledger are the brand's institutional memory. Exportable, but the *models* learned from it live here. An agency with 30 clients on playbooks does not move. | Strong after six months per brand. |
| **Counter-positioning** | Incumbents monetize seats. Agents collapse seats. Pricing on accounts under management and outcomes, with operators included, is a model Hootsuite and Sprinklr cannot adopt without cannibalizing core revenue. They will add agents as features and keep seat pricing, which is exactly the opening. | Strong for three to five years, until the incumbents' revenue mix is forced to turn over. |
| **Process power** | The eval and learning loop: approvals and diffs feeding voice models, ledger feeding forecasts, experiments feeding recommendations. Hard to copy because it's organizational discipline plus accumulated data, not code. | Medium; compounds with usage. |
| **Scale economies** | Platform API costs (metered X reads, licensed data) and model costs amortize across brands. A graph built once serves everyone. | Medium. Real at agency scale. |
| **Branding** | "The system of record for attention." If it becomes the thing serious brands and agencies are expected to run, that's a position, like Bloomberg in finance. Earned, not built. | Long-term; follows the others. |

The honest summary: in year one the moat is cornered resource plus counter-positioning. In years two and three it becomes switching costs and process power. From year three onward it is network economies, and that is the one that makes it hard to catch for a decade.

**Sequencing rule:** every roadmap decision should ask "does this strengthen a power, and which one?" Features that strengthen none are maintenance.

---

## 5. What could kill it, and the hedge

| Threat | Why it's real | Hedge |
|---|---|---|
| **AI labs absorb the function.** ChatGPT or Claude ships "connect your socials and I'll run them." | Plausible for simple cases. | Be the MCP server they call. Hold the OAuth, the policy, the ledger, the approvals. Labs want to be the interface, not the system of record. Make being the record the whole point. |
| **Platforms cut off access further.** | Already happening. | Diversify to open protocols and licensed sources; never let a core feature depend on a scraped source; pursue official partner status early; treat the historical record as the asset that survives any cutoff. |
| **Incumbents add agents and ledgers.** | They will add agents. Ledgers cross product lines they've kept separate for a decade. | Move fast on the ledger and the cross-brand graph; counter-position on pricing; publish the open schema first so the category's data model is yours. |
| **Commoditization of publishing tooling.** | Already at $6/month. | Never compete there. Buy connectors, own the knowledge. |
| **Trust failure.** An autonomous operator posts something harmful. | One incident can end an agency relationship. | Red lines enforced on every output; conservative default autonomy; Steward operator as a mandatory gate; full reversibility and logging; disclosure by default. Make safety the sales pitch, not a footnote. |
| **Regulation on AI content and data.** | EU AI Act Article 50 in force; more coming. | Provenance and disclosure built in; per-workspace data residency; consent-based cross-brand learning with opt-out; everything exportable and deletable. |
| **Data licensing costs rise.** | Reddit's "other revenue" is up 24% YoY; others will follow. | Scale economies via agencies; prioritize open and owned sources; price data pass-through transparently. |

---

## 6. Business model

Price what the customer values and the incumbents can't: **attention under management**, not seats.

- **Per connected account per month**, sliding with volume, operators included. No per-user fees, ever.
- **Tiers by autonomy and depth.** Observe (graph and ledger, no posting), Operate (operators with approvals), Autonomous (dial unlocked, experiments, benchmarks).
- **Agency partner tier.** Multi-client command, white label, per-client billing pass-through, playbook marketplace revenue share.
- **Data pass-through.** Metered platform costs (X reads, licensed sources) shown and billed transparently with caps the customer sets.
- **Enterprise.** Residency, SSO, custom red-line policy engines, dedicated graph slices.

The pricing itself is a moat, because it is the one thing seat-based incumbents cannot copy without hurting themselves.

---

## 7. The 24-month arc and the wedge

The best products start narrow. The wedge is the one thing nobody else does and the first users would pay for alone.

**The wedge: the closed loop for agencies.** Trend to post to outcome, per client, with evidence. An agency with ten clients can show each one "we saw it early, we acted, here's what it did," every week, with receipts. That is the deliverable agencies struggle most to produce and clients value most. It needs the graph (basic), the ledger, the Studio, and the Analyst operator. It does not need the full network.

**Months 0–3: Foundation and wedge.**
Event store, ledger, connectors via Zernio plus native X and Bluesky, Studio with voice capture, Watch and Studio operators, red lines v1, approval queue, MCP server, Analyst weekly brief. Google Trends alpha application, all platform reviews submitted on day one. Three to five friendly agencies as design partners. The target proof: an agency shows a client a weekly brief generated from the ledger and the client renews.

**Months 3–6: Measurement that proves.**
Outcome snapshots at all offsets, link layer, site and conversion ingestion, first experiments, incrementality v1, AI-answer visibility sampling, Desk operator with autonomy dial on replies, native Meta adapter as review clears. Target proof: an experiment result changes a client's strategy and the ledger shows the lift.

**Months 6–12: Forecast and trust.**
Forecast curves with confidence bands, per-brand learned models, Steward operator, C2PA and disclosure records, full export, data residency, agency partner tier, native TikTok and LinkedIn as approvals land. Twenty to fifty agencies. Target proof: forecast calibration measured and published to users; autonomy dials moving up on their own evidence.

**Months 12–24: The network.**
Cross-brand priors with consent, benchmarks by vertical, playbooks and marketplace, open event schema published, partner program for complementary tools emitting into the schema, licensed data partnerships. Hundreds of agencies, thousands of brands. Target proof: forecasts measurably better for brands in the network than out of it; first playbook revenue to an agency.

**Beyond:** the system of record for attention. Platforms, tools, and agents emit into it. Strategy is decided on it. Its benchmarks are quoted.

---

## 8. Architecture essentials

The plan's stack stands. The thesis adds emphasis, not technology.

- **Two spines.** Data spine: immutable event store, ledger, Timescale metrics, pgvector embeddings, all derivations versioned and rebuildable. Policy spine: red lines, autonomy dials, approvals, disclosure, one policy object consulted by UI, operators, and MCP alike.
- **Headless first.** One typed API. Web UI, MCP server, and operators are all clients of it.
- **Operators as a runtime.** Long-running agent loops with tool access limited by role and policy, every action an event, built on the Claude Agent SDK, model behind a gateway with evals drawn from the brand's own approvals.
- **Forecasting as a service.** Separate workers; start with robust statistical methods on the topic time series and layer learned models as the ledger grows. Always emit a band.
- **Tenancy with a shared layer.** Strict per-workspace isolation for raw and identifiable data; a separate, consented, aggregated layer for cross-brand priors and benchmarks. Designed so a regulator or an enterprise security team can see the wall.
- **Open schema from month 12.** Versioned, documented, with reference emitters.

---

## 9. Name and position

The product is **Base Air**: the fixed point you steer attention by. It sounds like something a strategist runs,
not something a social media manager uses, which is the point.

Position: *"The system of record for attention. See it coming, act inside your red lines, prove what moved."*

## 10. This month

1. Create the repository and grant access. Scaffold the two spines, the connector interface, the scheduler, the MCP server skeleton, and the first operator loop.
2. Submit every platform application and the Google Trends alpha request. These clocks only start when you start them.
3. Recruit three design-partner agencies and get their red lines and their last 90 days of posts into the ledger. Historical ingestion makes the product useful before it has posted anything.
4. Write the open event schema v0 internally now, even if it's published later. Designing to it from the start is what makes the ledger clean.
5. Decide the X spend cap and the default autonomy posture for new brands.
