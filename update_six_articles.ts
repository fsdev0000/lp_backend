import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function countWords(str: string): number {
  if (!str) return 0;
  return str.trim().split(/\s+/).filter(Boolean).length;
}

const ARTICLE_1_CONTENT = `# Your Revenue Is Growing. Why Isn’t Your Profit?

Revenue is up.

You have more clients. More people. Bigger projects. Maybe another market.

From the outside, the company looks stronger than ever.

Then you look at the bottom line.

And the numbers tell a different story.

You are doing significantly more business, but you are not making significantly more money.

I see this more often than founders like to admit.

And I understand why.

Revenue feels like winning.

It is visible. Your team celebrates a record month. People congratulate you when you cross €10 million, €20 million or €50 million.

Nobody opens a bottle of champagne because operational complexity went down by 12%.

But that may be far more valuable.

Bigger is easy to see. Better is harder.

Imagine two companies.

Company A generates €10 million in revenue with 25 people.

Company B generates €15 million with 50 people.

Which company is performing better?

You don’t know.

Not until you see what is left.

Not until you understand the margins, overhead, productivity, cash flow and how much management attention is required to produce those numbers.

Yet revenue is often the headline.

I have built companies myself. I understand the attraction.

Growth creates momentum. Momentum creates confidence. And confidence makes it very easy to keep adding.

Another salesperson.

Another manager.

Another system.

Another service.

Another project that feels too big to turn down.

Individually, every decision can make sense.

Collectively, they can build a company that is growing in size and declining in quality.

## Growth Can Hide Expensive Mistakes

When revenue keeps increasing, inefficiency has somewhere to hide.

A mediocre project still brings in revenue.

An unnecessary hire disappears into payroll.

Poor pricing gets compensated by volume.

A weak manager gets another person added to the team.

A process that should take two steps takes six, but everybody is busy, so it looks productive.

And because the company is still growing, there is no immediate reason to challenge it.

Until the margin stops moving.

That is when I would ask a different question:

Are we building a bigger company, or a better company?

## Look at What Every Additional Dirham Costs You

Instead of looking only at how much additional revenue the company generated, look at what was required to produce it.

For every additional dirham of revenue:

How many people did you add?

How much overhead?

How much management?

How much working capital?

How much complexity?

How much of your own attention?

And finally:

How much additional profit did you actually create?

That conversation can reveal things a revenue graph never will.

Your largest client may not be your best client.

Your biggest project may consume your strongest people while producing an average margin.

Headcount may be growing faster than productivity.

Managers may have become coordinators instead of owners.

You may even discover that part of your organisation exists because of decisions nobody has questioned for years.

These are not signs that the company is unsuccessful.

They are reasons to become more demanding about what success means.

## The Next Level Requires a Different Standard

I learned something in professional football that stayed with me throughout my business career.

Winning changes the competition.

Once you become successful, people start watching.

Competitors analyse you. They recruit. They invest. They improve.

And when you move into a higher competition, the standard rises again.

Business works the same way.

The company that took you from €2 million to €10 million may not be the company capable of taking you from €10 million to €25 million profitably.

Different scale.

Different decisions.

Different people.

Different systems.

Different expectations.

This is where founders can make an expensive mistake.

They take everything from the previous level with them and simply add more.

More people. More management. More systems. More meetings.

But sometimes the next level requires addition.

Sometimes it requires subtraction.

Knowing the difference is leadership.

## More People May Be the Wrong Answer

“We need another person.”

Maybe.

But before approving the hire, I would want to know why.

Is there genuinely too much work?

Or is the work badly organised?

Does the manager need another employee?

Or does the manager need to manage better?

Do you have a capacity problem?

Or an execution problem?

Those questions lead to completely different decisions.

The same discipline applies to projects, clients, systems and management layers.

Growth should earn its complexity.

If something makes the organisation bigger without making it stronger, more profitable or more capable, it deserves to be challenged.

## Winning Requires Reinvention

Past success deserves respect.

But past success can also become evidence for keeping things exactly as they are.

“It worked.”

Yes.

At that level.

Under those circumstances.

Against that competition.

At that moment.

The next level owes you nothing.

So look at the company without sentiment.

What still deserves to be here?

What needs to improve?

What should disappear?

What needs to be built now for the company you intend to become?

Becoming successful is one achievement.

Staying successful requires continuous reinvention.

Success proves what worked yesterday. It tells you very little about what will win tomorrow.

So if your revenue is growing and your profit isn’t, pay attention.

Your company may already have reached the next level in size.

The real question is whether it has reached the next level in performance.`;

const ARTICLE_2_CONTENT = `# You Don’t Need More People. You Need Better Execution.

“We need more people.”

I have heard that sentence in growing companies for years.

Sales is overloaded. Operations cannot keep up. Finance is behind. Managers are stretched. Projects take too long.

The obvious answer seems to be recruitment.

Sometimes it is.

But I would never start there.

Because adding people to a company that does not execute well rarely solves the problem.

It makes the problem more expensive.

## Busy Is Not the Same as Productive

Walk into almost any growing company and people look busy.

Calendars are full.

Meetings run back-to-back.

Emails arrive faster than anyone can answer them.

Projects are everywhere.

People work late.

And yet deadlines are missed, decisions remain open and the same issues keep returning.

That is not necessarily a capacity problem.

It can be an execution problem.

The distinction matters.

If ten people are working inside an unclear system, adding five more people gives you fifteen people working inside an unclear system.

You have increased capacity on paper.

You have also increased payroll, communication, management and complexity.

The question should come before the recruitment request:

What exactly is preventing the people we already have from performing better?

## Follow the Work

Forget the organisation chart for a moment.

Follow one important piece of work through the company.

A client request comes in.

Who owns it?

Who makes the decision?

How many people touch it?

How many approvals are required?

How often does it stop because somebody is waiting for somebody else?

How many times is the same information entered, discussed or checked?

And when something goes wrong, where does it end up?

That last question is especially useful.

In many founder-led companies, the answer is eventually:

with the founder.

Not because the founder wants to control everything.

Often because somewhere inside the organisation, ownership becomes unclear.

And when ownership disappears, work travels upwards.

## Management Should Create Capacity

A growing company eventually needs management.

But adding managers does not automatically improve management.

A manager who mainly collects updates, forwards problems and organises meetings has added another layer without necessarily adding more performance.

Good management should create capacity.

Decisions should happen closer to the work.

Priorities should become clearer.

Problems should be solved earlier.

People should know what they own.

The founder should be required for fewer operational decisions as the company grows, not more.

That gives you a useful test.

If you doubled the size of your management team over the last three years, has the organisation become easier to run?

Are decisions faster?

Is accountability clearer?

Are fewer issues reaching the founder?

Are projects being completed more reliably?

If the answer is no, headcount may not be your first problem.

## I Learned This in Football

A football club does not improve simply by signing more players.

You can have an expensive squad and still perform badly.

Why?

Because performance depends on how the team functions.

Players need to understand their role.

The system needs to be clear.

Decisions need to be made quickly.`;

const ARTICLE_3_CONTENT = `# Why Your Management Team Keeps Bringing Problems Back to You

You hired managers for a reason.

To take responsibility.

To make decisions.

To lead people.

To solve problems without everything having to come back to you.

Then the company grows.

The management team gets bigger.

You have more meetings, more reporting and more people with impressive titles.

Yet somehow, the difficult decisions still end up on your desk.

A client issue.

A hiring decision.

A pricing exception.

A project that is falling behind.

A conflict between departments.

A decision that apparently needs “your approval.”

At some point, you have to ask:

Why am I paying people to manage if I am still managing through them?

## The Problem Is Not Always the Manager

It is easy to blame management.

Sometimes that is justified.

Some people are simply not strong enough for the position they hold.

But I would look deeper before replacing them.

Because founders can create management dependency without realising it.

You built the company.

You know the clients.

You understand the history behind decisions.

You can often see the answer faster than everyone else.

So when somebody brings you a problem, you solve it.

It feels efficient.

Five minutes. Decision made. Move on.

But something else happened.

The manager learned that bringing the problem to you works.

Do that often enough and you create a pattern.

They bring.

You solve.

They execute.

You call it speed.

The organisation learns dependency.

## A Title Does Not Create Ownership

You can promote someone to manager tomorrow.

You cannot promote them into ownership.

Ownership appears when someone understands what result they are responsible for and knows they are expected to make decisions to achieve it.

That sounds obvious.

In practice, I see something different.

Managers are responsible for departments, but nobody has clearly defined the result that department must produce.

They attend meetings.

They report numbers.

They manage staff.

They escalate issues.

They stay busy.

But ask a simple question:

What result do you personally own?

The answer becomes vague.

And when ownership is vague, accountability becomes vague.

Problems move sideways.

Then upwards.

Eventually, they reach the person whose ownership has never been unclear.

The founder.

## Stop Accepting Problems Without Thinking

There is a difference between escalation and delegation upwards.

Some decisions should reach the founder.

Major capital allocation.

Strategic changes.

Serious legal or reputational risks.

Key appointments.

Decisions that materially change the direction of the company.`;

const ARTICLE_4_CONTENT = `# Your Best Clients May Be Costing You Money

Every company has clients it is proud of.

Big names.

Large contracts.

Long relationships.

Clients that look good on the website and even better in a sales presentation.

Then you look underneath the revenue.

And sometimes the picture changes.

The client everyone is proud to have may be one of the least attractive clients in the business.

Not because they do not pay.

Because of what it takes to serve them.

## Revenue Can Make a Bad Client Look Good

Imagine a client generating €1 million a year.

That sounds important.

Now look at what sits behind that number.

Special pricing.

Custom reporting.

Constant exceptions.

Senior management involved in operational issues.

Your best people solving problems.

Payment terms that put pressure on cash flow.

Projects changing after they have started.

Extra work nobody invoices.

And a founder who gets involved whenever the relationship becomes difficult.

Suddenly, €1 million looks different.

The question is no longer:

How much revenue does this client generate?

The better question is:

What does this client leave behind?

## Not All Revenue Is Equal

Two clients can generate exactly the same revenue and create completely different value.

One fits your organisation.

The work is repeatable.

Your team understands it.

The margin is strong.

Decisions are quick.

The relationship is professional.

The client pays on time.

The other generates the same revenue but requires constant attention.

Every project becomes an exception.

Your people work around the system.

Management gets involved.

Margins disappear through small concessions nobody tracks.

On the revenue report, they look identical.

Operationally, they are two completely different businesses.

This is why growth based purely on revenue can become dangerous.

You can sell more and make the company worse.

## Your Best People Are Part of the Cost

Most companies know the direct cost of delivering a project.

Far fewer calculate the cost of attention.

That matters.

If your CEO, commercial director, operations manager and best technical people are repeatedly pulled into one account, that client is consuming something expensive.

Not only salaries.

Capacity.

Every hour your strongest people spend fixing avoidable problems is an hour they cannot spend improving the company, developing stronger clients or creating the next opportunity.

This is opportunity cost, and it rarely appears clearly on a P&L.

But the business feels it.

You see it when important internal projects keep getting delayed.

When management is constantly firefighting.

When the best employees become frustrated.

When one customer appears in every meeting.

A client can be profitable on paper and still weaken the organisation around it.

## Bigger Is Not Automatically Better

Football clubs understand this in a different way.

A famous player can be commercially attractive.

Big name. Big reputation. Big expectations.

But the real question is whether that player makes the team better.

Does he fit the system?

Does his contribution justify what the club invests in him?

What happens to the rest of the team when everything has to be organised around one player?

Business has the same temptation.

A prestigious client can become difficult to challenge because of its name, size or history.

Nobody wants to lose the account.

So the company adapts.

Then adapts again.

And slowly, the exception becomes the operating model.

That is when the client starts running part of your company.

## Know What You Are Willing to Tolerate

This does not mean difficult clients are bad clients.

Large, sophisticated clients often have high expectations.

Good.

High standards can make your company better.

A demanding client that pays properly, respects expertise and pushes your organisation to improve can be extremely valuable.

The distinction is important.

Demanding is not the same as destructive.

The problem begins when complexity, behaviour and economics no longer make sense together.

That requires founders to make decisions sales teams often dislike.

Increase the price.

Change the scope.

Stop providing work for free.

Standardise the process.

Renegotiate payment terms.

Say no to another exception.

And sometimes, walk away.

Turning down revenue feels uncomfortable.

Especially when you worked hard to win it.

But protecting revenue at any cost is not commercial discipline.

## Look at Your Top Ten

Take your ten largest clients.

Do not rank them by revenue.

Look at each one through a different lens.

Margin.

Cash flow.

Management time.

Operational complexity.

Strategic value.

Growth potential.

Pressure on your people.

Then ask:

If this client approached us today, knowing everything we know now, would we still accept the business on the same terms?

That question removes history from the decision.

And history can be expensive.

“We have worked with them for ten years” is not a business case.

Neither is:

“They are our biggest client.”

The relationship has to make sense today.

## Better Business Requires Better Choices

At one stage of growth, almost every piece of revenue matters.

You are building.

You need cash.

You need clients.

You need proof.

But as the company becomes stronger, the standard has to change.

You earn the right to become more selective.

Which projects deserve your capacity?

Which clients deserve your strongest people?

Where can you create the most value?

Where can you capture enough of that value in return?

That is part of moving to the next level.

Because the goal is not to build a company that can say yes to everything.

The goal is to build a company that knows what is worth saying yes to.

Your largest client may be your best client.

But don’t assume it.

Look at what is left after the revenue.

Sometimes the most profitable decision you can make is deciding which revenue you no longer want.`;

const ARTICLE_5_CONTENT = `# The Meeting Ended. Nothing Changed.

The meeting was good.

Everyone contributed.

The numbers were discussed.

Problems were raised.

Ideas were exchanged.

Decisions seemed to be made.

People left the room feeling that progress had been made.

Then a week passes.

The same issue appears again.

The same project is still behind.

The same decision is still waiting.

The same names come up.

And someone says:

“We discussed this last week.”

Exactly.

You discussed it.

But did anything change?

## Meetings Create the Illusion of Progress

A meeting is easy to mistake for work.

People are together.

Information is moving.

Questions are being asked.

There is energy in the room.

That feels productive.

But the value of a meeting is not determined by what happens during the meeting.

It is determined by what happens afterwards.

What decision was made?

Who owns it?

What needs to happen?

By when?

And what happens if it doesn’t?

If those questions cannot be answered, you probably did not have a management meeting.

You had a conversation.

## Listen to the Language

You can learn a lot about a company by listening to how people speak in meetings.

“We should look into that.”

“Someone needs to speak to the client.”

“Let’s keep an eye on it.”

“We need to improve communication.”

“Maybe we should come back to this next week.”

All reasonable sentences.

Almost completely useless unless somebody owns what happens next.

Compare that with:

“David owns this.”

“He will speak to the client by Thursday.”

“The revised proposal will be ready Friday at 12:00.”

“We review the result next Monday.”

Now something can happen.

Clarity is rarely complicated.

But it can be uncomfortable.

Because once ownership is clear, performance becomes visible.

## The Same Problem Should Not Need the Same Meeting Twice

Recurring problems deserve attention.

A late project can happen.

A client complaint can happen.

A missed target can happen.

But if the same problem returns month after month, I become less interested in the problem itself.

I become interested in the system around it.

Why was it not solved?

Was there no owner?

Was the decision unclear?

Did nobody follow up?

Did management accept the explanation?

Was there a consequence?

Or did everyone simply move on until the next meeting?

Companies often spend enormous amounts of management time discussing symptoms.

Strong execution goes one step further.

It asks:

What needs to change so we do not have to discuss this again?

That is a very different conversation.

## More Meetings Are Rarely the Answer

When execution starts slipping, organisations often respond by adding communication.

Another meeting.

Another report.

Another dashboard.

Another update.

Another WhatsApp group.

Soon managers spend half their week explaining work instead of improving it.

More communication can help when information is missing.

But when ownership is missing, more communication simply creates more places to talk about the same problem.

I would rather see a company run three disciplined meetings that produce decisions than fifteen meetings that produce updates.

The standard should be simple:

Every meeting needs a reason to exist.

If it does not improve a decision, remove a blockage, create accountability or move an important result forward, ask why you are having it.

## Football Taught Me the Difference

In professional football, the dressing room can have a brilliant tactical meeting before the game.

Everyone understands the plan.

The manager explains exactly what needs to happen.

The video analysis is perfect.

But none of it matters once the referee blows the whistle.

Now somebody has to perform.

The striker has to finish.

The defender has to make the tackle.

The midfielder has to make the decision.

Nobody gets three points because the preparation meeting was excellent.

Business is the same.

The meeting is preparation.

Execution is the match.

And the scoreboard does not care how good the discussion was.

## Founders Can Accidentally Make This Worse

There is another trap.

When a meeting becomes unclear, the founder often steps in.

He summarises.

Makes the decision.

Assigns the action.

Pushes everybody forward.

Problem solved.

Except the organisation has learned something again:

When clarity disappears, the founder will create it.

Do that often enough and meetings become dependent on the founder’s presence.

That is not scalable.

A strong management team should be able to leave a room knowing exactly what has been decided without the founder having to translate the entire conversation into action.

The founder should raise the standard.

Management should learn to maintain it.

## Measure Meetings by What Changes

Try something simple.

At the end of your next management meeting, forget the quality of the discussion.

Ask four questions:

What did we decide?

Who owns it?

When will it be done?

How will we know it worked?

If the room cannot answer those questions clearly, do not schedule another meeting to discuss the same subject.

Finish this one properly.

Because as companies grow, execution becomes a competitive advantage.

Most companies have ideas.

Most have strategies.

Most know roughly what they should improve.

The difference appears in what actually gets done.

The next level will not be reached through better conversations alone.

It will be reached when conversations consistently become decisions, decisions become actions, and actions produce results.

So after your next meeting, do not ask:

“Was that a good meeting?”

Ask:

“What will be different because we had it?”

If the answer is nothing, the meeting was never the problem.

Your standard of execution was.`;

const ARTICLE_6_CONTENT = `# The Company You Built Cannot Run the Company You’re Becoming

You built something that works.

Clients buy.

Revenue grows.

People join.

The company develops a reputation.

What once depended on five people now involves twenty-five, fifty or a hundred.

That is success.

But growth eventually creates an uncomfortable question:

Is the company you built capable of running the company you are becoming?

Because every business has a point where the way it became successful starts limiting what it can become next.

## What Worked Before Was Not Wrong

Founders often wait too long to change because the current model has evidence behind it.

It worked.

The founder knew every client.

Important decisions happened quickly.

The best people could walk into the founder’s office and solve something in five minutes.

Everybody knew what was happening.

There were few layers.

Speed came naturally.

Then the company grew.

Twenty employees became fifty.

One market became three.

Five major clients became twenty.

Projects became larger.

More managers arrived.

More money was at stake.

And the informal way of running the company started carrying a level of complexity it was never designed for.

That does not mean the old way was bad.

It means the company has outgrown it.

## Growth Changes the Game

I recognise this from professional football.

A team can dominate at one level with a certain style, squad and way of working.

Then it moves into stronger competition.

Suddenly there is less space.

Mistakes are punished faster.

Opponents are better prepared.

The physical standard rises.

The tactical standard rises.

The quality of the bench matters.

Preparation becomes more sophisticated.

You cannot simply say:

“But this is how we became champions.”

Correct.

That is what got you here.

Now you are playing a different game.

Business works the same way.

The processes that worked at €5 million may become chaotic at €20 million.

The management team that helped you build €10 million may need to develop significantly to lead €30 million.

The founder who could personally approve every important decision eventually becomes the reason decisions are waiting.

Every new level exposes something the previous level allowed you to get away with.

## Complexity Arrives Quietly

The dangerous thing about complexity is that it rarely arrives as one major problem.

It accumulates.

Another approval.

Another manager.

Another software system.

Another report.

Another meeting.

Another exception for an important client.

Another process created because something went wrong once.

Every addition has a reason.

Three years later, nobody can explain why the company needs half of it.

People become busy navigating the organisation instead of serving the customer or improving the business.

That is when growth starts creating weight.

And weight eventually slows performance.

## Your Organisation Should Not Depend on Memory

In smaller companies, knowledge lives inside people.

Ask Peter.

Sarah knows how that works.

The founder has the relationship.

Finance knows the agreement.

Operations remembers what happened last time.

That can work surprisingly well.

Until one of those people leaves.

Or the company doubles.

Or somebody opens another office.

Then institutional memory becomes institutional risk.

A company preparing for its next level needs to turn important knowledge into organisational capability.

Clear responsibilities.

Clear decision rights.

Repeatable processes where repetition matters.

Reliable information.

Managers who understand the business beyond their own department.

Systems that support execution rather than create administration.

Not bureaucracy.

Infrastructure.

There is a difference.

## The Founder Has to Change Too

This is usually the most difficult part.

The company can only change so far while the founder continues operating exactly as before.

At one stage, being involved in everything is an advantage.

You create speed.

You protect quality.

You transfer your standards directly.

At another stage, the same behaviour can restrict the organisation.

The founder now has to decide where his attention creates the highest value.

Not:

“What can I do?”

A successful founder can usually do a lot.

The better question is:

“What should only I be doing now?”

Strategy?

Capital?

Key relationships?

Senior leadership?

Major commercial decisions?

Future opportunities?

If the founder spends most of the week solving issues that someone two levels below could solve, the company is paying an enormous opportunity cost.

Not because his time is expensive.

Because his attention is being used at the wrong level.

## Do Not Build for the Company You Have

This is where I would challenge many growing businesses.

They organise themselves around today’s problems.

Today’s workload.

Today’s clients.

Today’s headcount.

Today’s revenue.

But if you already know where you want the company to go, today’s organisation cannot be your only reference point.

If you intend to double revenue, enter new markets or become the leading company in your niche, ask:

What will that company require from us that the current company does not?

Which capabilities?

Which leaders?

Which technology?

Which processes?

Which standards?

What needs to exist before the growth arrives?

You do not prepare for the Champions League after the first match starts.

You prepare because you know where you intend to compete.

## Reinvent Before You Are Forced To

Companies usually change for one of two reasons.

Ambition forces them to.

Or pain eventually does.

I prefer the first.

You do not need to wait until margins collapse, good people leave or execution starts breaking down before challenging how the company operates.

Success gives you the opportunity to change from a position of strength.

Use it.

Keep what still works.

Strengthen what needs to become better.

Remove what no longer earns its place.

Build what the next level requires.

Because the company you built deserves respect.

It got you here.

But loyalty to the past should never become a limitation on the future.

Never prepare for where you are. Prepare for where you intend to compete.`;

const ARTICLES_CONFIG = [
  {
    db_id: '5d1edea2-c93e-48be-a6c5-649522671e99',
    old_slug: 'what-is-founder-dependency',
    title: 'Your Revenue Is Growing. Why Isn’t Your Profit?',
    slug: 'your-revenue-is-growing-why-isnt-your-profit',
    pillar: 'Business Performance',
    pillar_color: 'hsl(14,52%,45%)',
    content: ARTICLE_1_CONTENT,
    excerpt:
      'Revenue feels like winning, but growth can hide expensive mistakes. Discover why increasing business does not automatically produce profit, and how to measure what every additional dirham truly costs.',
    meta_title: 'Your Revenue Is Growing. Why Isn’t Your Profit? | Leaders Performance',
    meta_description:
      'Why growth hides expensive mistakes and how high-performing founders examine margins, complexity, and productivity to scale sustainably.',
    keywords: [
      'revenue vs profit',
      'business performance',
      'operational complexity',
      'profitability',
      'scaling clean',
      'founder leadership',
      'growth strategy',
    ],
  },
  {
    db_id: '28e77779-fc58-40ec-b389-5fcf8488844c',
    old_slug: 'founder-burnout-structural-warning-signal',
    title: 'You Don’t Need More People. You Need Better Execution.',
    slug: 'you-dont-need-more-people-better-execution',
    pillar: 'Leadership Performance',
    pillar_color: 'hsl(215,28%,38%)',
    content: ARTICLE_2_CONTENT,
    excerpt:
      'Adding people to an organisation that struggles to execute does not solve the problem—it simply makes it more expensive. Learn how clear ownership and operating discipline create real capacity.',
    meta_title: 'You Don’t Need More People. You Need Better Execution. | Leaders Performance',
    meta_description:
      'Why recruiting more staff compounds confusion in unclear systems, and how disciplined execution creates true capacity without adding overhead.',
    keywords: [
      'execution discipline',
      'operational capacity',
      'leadership performance',
      'headcount management',
      'accountability',
      'scaling operations',
      'founder leadership',
    ],
  },
  {
    db_id: '8f752ec8-efa6-498f-b3a9-aabe63cebb41',
    old_slug: 'growth-without-control',
    title: 'Why Your Management Team Keeps Bringing Problems Back to You',
    slug: 'why-your-management-team-keeps-bringing-problems-back-to-you',
    pillar: 'Founder Operations',
    pillar_color: 'hsl(38,45%,53%)',
    content: ARTICLE_3_CONTENT,
    excerpt:
      'When managers escalate decisions they should resolve themselves, the issue is rarely just their ability. Understand how founders inadvertently train dependency, and how to institute genuine ownership.',
    meta_title: 'Why Your Management Team Keeps Bringing Problems Back to You | Leaders Performance',
    meta_description:
      'How founders accidentally create management dependency by solving upward delegations, and how to restructure ownership so teams solve their own problems.',
    keywords: [
      'management dependency',
      'founder operations',
      'delegation upwards',
      'ownership',
      'decision rights',
      'accountability',
      'executive leadership',
    ],
  },
  {
    db_id: '785577a5-1ce0-47ac-982b-5f07b79e528c',
    old_slug: 'the-founder-bottleneck-causes-and-fixes',
    title: 'Your Best Clients May Be Costing You Money',
    slug: 'your-best-clients-may-be-costing-you-money',
    pillar: 'Business Performance',
    pillar_color: 'hsl(14,52%,45%)',
    content: ARTICLE_4_CONTENT,
    excerpt:
      'Prestige accounts often carry hidden costs in senior attention, unbilled concessions, and operational friction. Learn why evaluating what a client leaves behind matters more than top-line turnover.',
    meta_title: 'Your Best Clients May Be Costing You Money | Leaders Performance',
    meta_description:
      'Why high-revenue clients can drain your best people and erode profitability, and how to evaluate client performance beyond headline sales figures.',
    keywords: [
      'client profitability',
      'opportunity cost',
      'business performance',
      'margin analysis',
      'client management',
      'commercial discipline',
      'founder leadership',
    ],
  },
  {
    db_id: '56b30ccc-3f4c-47d5-880f-e16f7a456a23',
    old_slug: 'founder-mental-load',
    title: 'The Meeting Ended. Nothing Changed.',
    slug: 'the-meeting-ended-nothing-changed',
    pillar: 'Leadership Performance',
    pillar_color: 'hsl(215,28%,38%)',
    content: ARTICLE_5_CONTENT,
    excerpt:
      'Good discussions do not equate to operational progress. Discover why recurring meetings signal missing ownership and how to convert conversations into firm decisions, clear owners, and measurable outcomes.',
    meta_title: 'The Meeting Ended. Nothing Changed. | Leaders Performance',
    meta_description:
      'How to eliminate the illusion of progress in executive meetings, establish rigorous ownership, and ensure discussions lead to immediate action.',
    keywords: [
      'meeting effectiveness',
      'leadership performance',
      'execution discipline',
      'decision making',
      'ownership',
      'operational rhythm',
      'founder leadership',
    ],
  },
  {
    db_id: 'e74392ed-2633-4369-ab3e-66279cfaf960',
    old_slug: 'hidden-conflicts',
    title: 'The Company You Built Cannot Run the Company You’re Becoming',
    slug: 'the-company-you-built-cannot-run-the-company-youre-becoming',
    pillar: 'Leadership Performance',
    pillar_color: 'hsl(215,25%,35%)',
    content: ARTICLE_6_CONTENT,
    excerpt:
      'The informal habits and personal founder involvement that drove early success eventually become the very constraints holding you back. Learn how to evolve your operating model before complexity forces change.',
    meta_title: 'The Company You Built Cannot Run the Company You’re Becoming | Leaders Performance',
    meta_description:
      'Why scaling to the next level requires upgrading from personal founder control to institutional capability, clear systems, and proactive reinvention.',
    keywords: [
      'scaling business',
      'organisational capability',
      'leadership performance',
      'founder evolution',
      'system design',
      'operating model',
      'reinvention',
    ],
  },
];

async function main() {
  console.log('--- Starting 6 New Articles Database Migration ---');

  // Verify initial count
  const initialCountRows = await prisma.$queryRawUnsafe<any[]>('SELECT count(*) as count FROM public.articles;');
  const initialCount = parseInt(initialCountRows[0].count, 10);
  console.log(`Initial articles in database: ${initialCount}`);

  const results: any[] = [];

  for (const item of ARTICLES_CONFIG) {
    const reading_time = Math.max(3, Math.ceil(countWords(item.content) / 200));
    console.log(`Updating DB ID: ${item.db_id} (${item.old_slug} -> ${item.slug})...`);

    const updateRows = await prisma.$queryRawUnsafe<any[]>(
      `
      UPDATE public.articles
      SET
        title = $1,
        slug = $2,
        excerpt = $3,
        pillar = $4,
        pillar_color = $5,
        content = $6,
        meta_title = $7,
        meta_description = $8,
        author = $9,
        reading_time = $10,
        keywords = $11::text[],
        published = true,
        updated_at = NOW()
      WHERE id = $13::uuid
      RETURNING id, slug, title, updated_at;
    `,
      item.title,
      item.slug,
      item.excerpt,
      item.pillar,
      item.pillar_color,
      item.content,
      item.meta_title,
      item.meta_description,
      'Lionel Eersteling',
      reading_time,
      item.keywords,
      true,
      item.db_id
    );

    if (updateRows.length === 0) {
      throw new Error(`Failed to update article with ID ${item.db_id} - record not found!`);
    }

    results.push({
      id: updateRows[0].id,
      old_slug: item.old_slug,
      new_slug: updateRows[0].slug,
      title: updateRows[0].title,
      updated_at: updateRows[0].updated_at,
    });
  }

  // Verify post-migration count
  const finalCountRows = await prisma.$queryRawUnsafe<any[]>('SELECT count(*) as count FROM public.articles;');
  const finalCount = parseInt(finalCountRows[0].count, 10);
  console.log(`Final articles in database: ${finalCount}`);
  console.log(`Duplicates created: ${finalCount - initialCount}`);

  console.log('\n--- SUCCESS REPORT ---');
  console.log(JSON.stringify(results, null, 2));

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  prisma.$disconnect();
  process.exit(1);
});
