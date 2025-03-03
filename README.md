![Image](https://github.com/user-attachments/assets/d2eb56d2-e9cd-4b4f-842e-5bae775f5e9d)

## LLM Chaos

The basic idea is:

* You don't actually need to write any code.
* You declare (on Discord's website) a bot for each LLM you want to connect.
* You configure *llm_chaos* for each bot.
* *llm_chaos* handles the Discord <> LLM bridging (i.e. it is the bot, actually it is all the bots).

## Warning:

* You could run up API costs mighty quickly!

## Features:

* Ping LLMs to engage, they can also ping each other, if you tell them to.
* Has an attachment syntax (explained via system prompt) to let LLMs create attachments.
* Natively handles OpenAI, Anthropic, and Google APIs, as well as OpenRouter.
* Can extract reasoning from Anthropic and OpenRouter messages.

## Limitations:

* No image support.
* May not work perfectly with APIs not mentioned above.
* Basically a toy project, not intended for use by normal people.
