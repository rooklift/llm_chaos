"use strict";

// See https://discord.js.org
// Note that you must enable Message Content Intent in https://discord.com/developers/applications
// You also need to adjust Installation Settings to add "bot", "Send Messages", "Manage Messages"

const ai = require("./ai");
const discord = require("discord.js");
const helpers = require("./chaos_helpers");
const fs = require("fs");

process.chdir(__dirname);

const CHAR_TOKEN_RATIO = 3.6		// For token estimates and cost estimates

const DEFAULT_SP_FILE = "./system/system_prompt.txt";
const CONFIG_FILE = "./config.json";

let bots = [];

// ------------------------------------------------------------------------------------------------
// History objects storing only essential info out of a discord message, needed by the LLMs.

function new_history_object(opts) {
	let required = ["snow_big_int", "author_tag", "author_id", "author_type", "from_me", "pings_me", "text", "filename"];
	for (let field of required) {
		if (!Object.hasOwn(opts, field)) {
			throw new Error(`new_history_object: missing required field: ${field}`);
		}
	}
	let ret = Object.assign(Object.create(history_object_prototype), opts);
	return ret;
}

const history_object_prototype = {

	// Full strings include the headers, lesser strings (for the bot's own text) do not.
	// Note that, at time of writing, the bot's own text is stored whole, without splitting out attachments,
	// thus it never actually happens that lesser_string() is called on history_objects representing files.

	get_string: function(full) {
		if (this.filename) {
			let ret = full ? attachment_system_header(this) : "";
			ret += `<<<<<<<<<< ${this.filename}\n`;
			ret += this.text;
			ret += ret.endsWith("\n") ? ">>>>>>>>>>" : "\n>>>>>>>>>>";
			return ret;
		} else {
			let ret = full ? normal_system_header(this) : "";
			ret += this.text;
			return ret;
		}
	},

	full_string: function() { return this.get_string(true); },

	lesser_string: function() { return this.get_string(false); },
};

function normal_system_header(o) {
	return `[[ Message from ${o.author_tag} (${o.author_type}, userid ${o.author_id}) follows... ]]\n`;
}

function attachment_system_header(o) {
	return `[[ File attached by ${o.author_tag} (${o.author_type}, userid ${o.author_id}) follows... ]]\n`;
}

// ------------------------------------------------------------------------------------------------
// Given some LLM output, extract the main text and any file attachments...

function create_text_and_attachments(text) {				// Regex by GPT-4o

	let re = /<{5,20} ([^\n]+)\n([\s\S]*?)>{5,20}/g;		// Allow marker sizes <<<<< to <<<<<<<<<<<<<<<<<<<<

	let files = [];

	// Extract file contents...

	text = text.replace(re, (match, filename, content) => {
		files.push({filename, content});
		return "";											// Remove the file block from the remaining text
	});

	// We return the main text and an array of Discord Attachment objects...
	// Note that the main text may now have a bunch of whitespace junk added, but we clean that later.

	let built_arr = files.map(a => new discord.AttachmentBuilder(Buffer.from(a.content), {name: a.filename}));

	return [text, built_arr];
}

// ------------------------------------------------------------------------------------------------

function new_bot(cfg, common) {
	return Object.create(bot_prototype).init(cfg, common);
}

const bot_prototype = {

	init: function(cfg, common) {

		return new Promise((resolve) => {

			let ai_config = cfg.ai_config;

			Object.assign(this, {
				ai_client: null,								// Connection to the LLM via the ai library.
				conn: null,										// Connection to Discord.
				chaos: cfg.chaos || 0,							// Chance of responding randomly to a non-ping.
				emoji: cfg.emoji || "💡",						// Emoji used to acknowledge receipt of message.
				owner: common.owner,							// Name of the human in charge...
				sp_location: cfg.system_prompt || DEFAULT_SP_FILE,	// Location of the system prompt, for (re)loading.
				ping_blind: cfg.ping_blind || false,			// Whether this LLM's ping recognition is suppressed.
				history_limit: cfg.history_limit || common.history_limit,	// Max history length.
				poll_wait: cfg.poll_wait || common.poll_wait,	// Delay for maybe_respond_spinner().
				poll_id: null,									// setTimeout id, for cancellation.
				history: [],									// Using only history_objects as defined above.
				queue: [],										// Messages (as Discord objects) waiting to be processed.
				channel: null,									// The actual channel object, hopefully safe to store?
				in_flight: false,								// Any http request in progress, to LLM or Discord? Value can be string indicating why.
				ai_abortcontroller: null,						// AbortController for cancelling LLM requests only.
				cancelled: false,								// Assume this can be true even if nothing in-flight!
				last_msg: null,									// Last message received. Purely for emoji reactions.
				last_handled: BigInt(-1),						// Snowflake (as BigInt) of the last thing we responsed to. Can be artificially set with !break
				sent_chars: 0,									// Needs to be converted to token count to be useful.
				received_chars: 0,								// Likewise.
				input_price: cfg.input_price || 0,				// Expressed as dollars per million tokens.
				output_price: cfg.output_price || 0,			// Note that there are issues with not counting reasoning tokens.
			});

			this.ai_client = ai.new_client(ai_config);
			this.ai_client.set_api_key_from_file(cfg.llm_key_file);

			this.conn = new discord.Client({intents: [
				discord.GatewayIntentBits.Guilds,
				discord.GatewayIntentBits.GuildMessages,
				discord.GatewayIntentBits.MessageContent,
			]});

			this.conn.on("ready", () => {
				resolve(this);						// The promise returned by init() is resolved when the Discord connection is "ready"
			});

			let commands = {	// Note that the first arg received by all of these will be msg. Then any other args (which most don't use).
			"!abort":     [(msg, ...args) =>                 this.abort(msg, ...args), "Alias for !break."                                                 ],
			"!blind":     [(msg, ...args) =>         this.set_blindness(msg, ...args), "Set / toggle being ping-blind."                                    ],
			"!break":     [(msg, ...args) =>                 this.abort(msg, ...args), "Abort current operation. Bump last_handled marker."                ],
			"!chaos":     [(msg, ...args) =>             this.set_chaos(msg, ...args), "Set chaos value (chance of responding to non-pings)."              ],
			"!config":    [(msg, ...args) =>           this.send_config(msg, ...args), "Display LLM config in this channel."                               ],
			"!cost":      [(msg, ...args) =>             this.send_cost(msg, ...args), "Display estimated costs in this channel."                          ],
			"!costs":     [(msg, ...args) =>             this.send_cost(msg, ...args), "Alias for !cost."                                                  ],
			"!disconnect":[(msg, ...args) =>            this.disconnect(msg, ...args), "Just like it sounds."                                              ],
			"!effort":    [(msg, ...args) =>  this.set_reasoning_effort(msg, ...args), "Set reasoning effort (low / medium / high). Leave blank to clear." ],
			"!help":      [(msg, ...args) =>                       help(msg, ...args), "Display this message."                                             ],
			"!history":   [(msg, ...args) =>          this.dump_history(msg, ...args), "Dump the internal history to the console."                         ],
			"!input":     [(msg, ...args) =>        this.log_last_input(msg, ...args), "Dump the last body sent to the LLM's API to the console."          ],
			"!memory":    [(msg, ...args) =>     this.set_history_limit(msg, ...args), "Set the number of messages saved in the history."                  ],
			"!output":    [(msg, ...args) =>       this.log_last_output(msg, ...args), "Dump the last body received from the LLM's API to the console."    ],
			"!poll":      [(msg, ...args) =>         this.set_poll_wait(msg, ...args), "Set the polling delay in milliseconds."                            ],
			"!reload":    [(msg, ...args) =>     this.set_system_prompt(msg, ...args), "Reload the system prompt from disk."                               ],
			"!reset":     [(msg, ...args) =>                 this.reset(msg, ...args), "Clear the history. Make the LLM use this channel."                 ],
			"!show":      [(msg, ...args) =>    this.set_show_reasoning(msg, ...args), "Set / toggle showing reasoning (if available) inline in the text." ],
			"!status":    [(msg, ...args) =>           this.send_status(msg, ...args), "Display essential bot status info in this channel."                ],
			"!system":    [(msg, ...args) =>    this.dump_system_prompt(msg, ...args), "Dump the system prompt to the console."                            ],
			"!tokens":    [(msg, ...args) =>        this.set_max_tokens(msg, ...args), "Set max_tokens for the LLM."                                       ],
			};

			let commands_that_can_be_sent_untargeted = ["!abort", "!break", "!reset"];		// Note that these aren't allowed to have arguments.
			let hidden_commands = ["!abort", "!costs"];										// Won't show up in help.

			let help = (msg) => {
				let st = ["```\nNormal commands - ping the LLM:\n"];
				for (let [key, value] of Object.entries(commands)) {
					if (!commands_that_can_be_sent_untargeted.includes(key) && !hidden_commands.includes(key)) {
						st.push(`  ${key.padEnd(14)} ${value[1].toString()}`);
					}
				}
				st.push("\nChannel commands - can optionally send without ping, to affect every LLM:\n");
				for (let [key, value] of Object.entries(commands)) {
					if (commands_that_can_be_sent_untargeted.includes(key) && !hidden_commands.includes(key)) {
						st.push(`  ${key.padEnd(14)} ${value[1].toString()}`);
					}
				}
				st.push("```");
				this.msg_reply(msg, st.join("\n"));
			};

			this.conn.on("messageCreate", (msg) => {
				if (this.msg_is_mine(msg)) {
					return;
				}
				let {cmd, args} = this.cmd_from_msg(msg, commands_that_can_be_sent_untargeted);
				if (Object.hasOwn(commands, cmd)) {
					try {
						commands[cmd][0](msg, ...args);
					} catch (error) {
						msg.channel.send(`Immediate exception: ${error}`).catch(error2 => {
							console.log(error2);
						});
					}
				} else {
					this.queue.push(msg);
				}
			});

			this.conn.login(fs.readFileSync(cfg.bot_token_file, "utf8"));
		});
	},

	start: function() {
		this.set_system_prompt();
		this.maybe_respond_spinner();
		this.process_queue_spinner();
	},

	disconnect: function(msg) {
		this.channel = null;
		this.abort();
		msg.channel.send("Goodbye.").finally(() => {
			this.conn.destroy();
		});
	},

	set_system_prompt: function() {

		let all_llm_info = [];

		for (let bot of bots) {

			let company = bot.ai_client.config.company;
			let tag = bot.conn.user.tag;
			let id = bot.conn.user.id;

			let special = [];
			if (bot.chaos > 0) special.push("chaotic");
			if (bot.ping_blind) special.push("ping-blind");
			let special_string = special.length ? `  <-- special flags: ${special.join(", ")}` : "";

			all_llm_info.push(`${bot.ai_client.config.full_name} created by ${company}, username ${tag} -- ping with <@${id}>${special_string}`);
		}

		let system_header_example = normal_system_header({author_tag: "exampleuser", author_type: "human", author_id: "1234567890"}).trim();

		this.ai_client.set_system_prompt_from_file(this.sp_location);
		this.ai_client.replace_in_system_prompt("{{userName}}", this.conn.user.tag, true);
		this.ai_client.replace_in_system_prompt("{{userId}}", this.conn.user.id, true);
		this.ai_client.replace_in_system_prompt("{{systemHeaderExample}}", system_header_example, true);
		this.ai_client.replace_in_system_prompt("{{modelsInTheServer}}", all_llm_info.join("\n"), true);
		this.ai_client.replace_in_system_prompt("{{serverOwner}}", this.owner, true);
	},

	process_queue: function() {
		while (true) {
			if (this.in_flight) {
				return;
			}
			if (this.queue.length === 0) {
				return;
			}
			let msg = this.queue.shift();
			if (!this.channel) {							// i.e. the first real message we ever see sets the channel.
				this.reset(msg);
			}
			if (this.channel.id !== msg.channelId) {		// msg is not in the valid channel, so skip.
				if (this.msg_mentions_me(msg)) {
					this.msg_reply(msg, "The LLM is not currently listening to this channel. Use !reset if you dare.");
				}
				continue;
			}
			// Note that, if a human pings the bot, the following 2 functions will instantly reply and set in_flight,
			// which prevents further processing of the queue (until later). That's intended behaviour.
			if (msg.attachments.size === 0) {
				this.process_simple_msg(msg);
			} else {
				this.process_msg_with_attachments(msg);		// While this likely could handle zero-attachment messages too, it's complex.
			}
		}
	},

	process_queue_spinner: function() {
		this.process_queue();
		setTimeout(this.process_queue_spinner.bind(this), 250);
	},

	process_simple_msg: function(msg) {
		this.add_base_message_to_history(msg);
		if (msg_from_human(msg) && this.msg_mentions_me(msg)) {
			this.maybe_respond();							// Instant response to human messages
		}
	},

	process_msg_with_attachments: function(msg) {

		this.in_flight = "Downloading attachments";
		this.cancelled = false;

		let all_fetches = attachment_fetches(msg);			// See that function for the format of the resolved values.

		Promise.allSettled(all_fetches).then(results => {
			if (this.cancelled) {
				return;
			}
			if (msg.content.trim()) {
				this.add_base_message_to_history(msg);		// Now's a good time to add the main msg to the history.
			}
			for (let result of results) {
				if (result.status === "fulfilled") {
					this.add_attachment_to_history(msg, result.value);
				} else {
					this.log(result.reason);
				}
			}
		}).then(() => {
			this.in_flight = false;
			if (!this.cancelled) {
				if (msg_from_human(msg) && this.msg_mentions_me(msg)) {
					this.maybe_respond();					// Instant response to human messages.
				}
			}
		});
	},

	log: function(...args) {
		console.log(this.conn.user.tag, ...args);			// Seems to work even if args is length 0.
	},

	reset: function(msg) {
		this.channel = msg.channel;							// Hopefully OK to hold a reference to.
		this.history = [];
		this.abort(msg);
	},

	msg_reply: function(msg, s) {							// Helper to send a reply to a msg, as a fire-and-forget action.
		if (s === undefined) {
			throw(new Error("Bad call to msg_reply"));
		}
		msg.channel.send(s).catch(error => {
			console.log(error);
		});
	},

	set_blindness: function(msg, val) {
		if (val && ["FALSE", "OFF"].includes(val.toUpperCase())) {
			this.ping_blind = false;
		} else if (val && ["TRUE", "ON"].includes(val.toUpperCase())) {
			this.ping_blind = true;
		} else {
			this.ping_blind = !this.ping_blind;
		}
		this.msg_reply(msg, `Ping blind: ${this.ping_blind}`);
	},

	set_show_reasoning: function(msg, val) {
		if (val && ["FALSE", "OFF"].includes(val.toUpperCase())) {
			this.ai_client.set_show_reasoning(false);
		} else if (val && ["TRUE", "ON"].includes(val.toUpperCase())) {
			this.ai_client.set_show_reasoning(true);
		} else {
			this.ai_client.set_show_reasoning(!this.ai_client.config.show_reasoning);
		}
		this.msg_reply(msg, `Show reasoning: ${this.ai_client.config.show_reasoning}`);
	},

	set_reasoning_effort: function(msg, val) {				// But I want to use this for Anthropic too...

		let as_num = parseInt(val);
		let s = "";

		if (this.ai_client.is_anthropic() && !Number.isNaN(as_num)) {
			this.ai_client.set_budget_tokens(as_num);
		} else {
			s = (typeof val === "string" && ["low", "medium", "high"].includes(val.toLowerCase())) ? val.toLowerCase() : "";
			this.ai_client.set_reasoning_effort(s);
		}

		if (this.ai_client.is_anthropic()) {
			this.msg_reply(msg, `Budget tokens: ${this.ai_client.config.budget_tokens}`);
		} else {
			this.msg_reply(msg, `Reasoning effort: ${s ? s : "default / won't send the field"}`);
		}
	},

	set_max_tokens: function(msg, val) {
		let n = parseInt(val);
		if (Number.isNaN(n) || n <= 0) {
			this.msg_reply(msg, "Invalid argument");
		} else {
			this.ai_client.set_max_tokens(n);
			this.msg_reply(msg, `Max tokens: ${n}`);
		}
	},

	set_chaos: function(msg, val) {
		let n = parseFloat(val);
		if (Number.isNaN(n)) {
			this.msg_reply(msg, "Invalid argument");
		} else {
			this.chaos = n;
			this.msg_reply(msg, `Chaos: ${n}`);
		}
	},

	set_history_limit: function(msg, val) {
		let n = parseInt(val);
		if (Number.isNaN(n) || n <= 0) {
			this.msg_reply(msg, "Invalid argument");
		} else {
			this.history_limit = n;
			this.truncate_history(n);
			this.msg_reply(msg, `Max history: ${n}`);
		}
	},

	set_poll_wait: function(msg, val) {
		let n = parseInt(val);
		if (Number.isNaN(n) || n <= 0) {
			this.msg_reply(msg, "Invalid argument");
		} else {
			if (this.poll_id) {
				clearTimeout(this.poll_id);
				this.poll_id = null;
			}
			this.poll_wait = n;
			this.msg_reply(msg, `Polling delay: ${n} milliseconds`);
			this.maybe_respond_spinner();						// Restart the polling loop.
		}
	},

	abort: function(msg = null) {
		if (this.ai_abortcontroller) {
			this.ai_abortcontroller.abort(new ai.AbortError());
			this.ai_abortcontroller = null;
		}
		this.cancelled = true;									// This relies on it being safe for this randomly to be true. It should be.
		if (msg) {
			this.last_handled = BigInt(msg.id) - BigInt(1);		// Prevent earlier messages being responded to; but not this message itself!
		}
	},

	set_all_history_handled: function() {						// Remember that some history objects have snow_big_int == -1 so don't trust
		let biggest = BigInt(-1);								// that the last history item will be the largest, it might not be.
		for (let item of this.history) {
			if (item.snow_big_int > biggest) {
				biggest = item.snow_big_int;
			}
		}
		this.last_handled = biggest;							// NOTE TO SELF: there was a big bug when these were getting set to -1 sometimes!
	},

	send_config: function(msg) {
		let foo = Object.assign({}, this.ai_client.config);
		foo.system_prompt = "SYSTEM_PROMPT_MARKER";
		let s = JSON.stringify(foo, null, 4);
		s = s.replaceAll("\"SYSTEM_PROMPT_MARKER\"", `[${this.ai_client.config.system_prompt.length} characters]`);
		this.msg_reply(msg, "```\n" + s.trim() + "\n```");
	},

	send_status: function(msg) {
		let hs = this.history_size();
		let spl = this.ai_client.config.system_prompt.length;
		let s = "```\n" +
		`User ID:         <@${this.conn.user.id}>\n` +
		`Channel:         ${this.channel?.id === msg.channel.id ? msg.channel.name : (this.channel ? "other" : this.channel)}\n` +
		`Ping-blind:      ${this.ping_blind}\n` +
		`Chaos:           ${this.chaos.toFixed(2)}\n` +
		`In flight:       ${this.in_flight}\n` +
		`Poll delay:      ${this.poll_wait}\n` +
		`Queue length:    ${this.queue.length}\n` +
		`History length:  ${this.history.length} (max ${this.history_limit}) --> concats to ${this.count_concatenated_history()}\n` +
		`History size:    ${(hs / CHAR_TOKEN_RATIO).toFixed(0)} tokens + ${(spl / CHAR_TOKEN_RATIO).toFixed(0)} S.P. tokens\n` +
		"```";
		this.msg_reply(msg, s);
	},

	send_cost: function(msg) {
		let itok = this.sent_chars / CHAR_TOKEN_RATIO;
		let otok = this.received_chars / CHAR_TOKEN_RATIO;
		let s = "```\n" +
		`I/O:             ${itok.toFixed(0)} tokens (input) + ${otok.toFixed(0)} tokens (output)\n` +
		`Cost:            ${this.estimated_cost()}\n` +
		"```";
		this.msg_reply(msg, s);
	},

	estimated_cost: function() {
		if (!this.input_price || !this.output_price) {
			return "Prices unknown!";
		}
		let input_tokens = this.sent_chars / CHAR_TOKEN_RATIO;
		let output_tokens = this.received_chars / CHAR_TOKEN_RATIO;
		let i_cost = input_tokens * this.input_price / 1000000;
		let o_cost = output_tokens * this.output_price / 1000000;
		let s = (i_cost + o_cost).toFixed(4);
		let dot_index = s.indexOf(".");
		while (s.endsWith("0") && s.length - dot_index > 3) {
			s = s.slice(0, -1);
		}
		return `$${s} (estimated; warning: ignores hidden reasoning!)`;
	},

	msg_is_mine: function(msg) {
		return msg.author.id === this.conn.user.id;
	},

	msg_mentions_me: function(msg) {												// Makes no attempt to recognise
		return msg.mentions.users.has(this.conn.user.id);							// @everyone nor @role mentions.
	},

	cmd_from_msg: function(msg, untargeted) {
		let default_result = {cmd: "", args: []};
		if (msg.content.length > 256) {												// Will I regret this later somehow?
			return default_result;
		}
		for (let cmd_to_all of untargeted) {										// Commands like !break and !reset that don't need a ping
			if (msg.content.trim() === cmd_to_all) {
				return {cmd: cmd_to_all, args: []};
			}
		}
		if (!this.msg_mentions_me(msg)) {
			return default_result;
		}
		let content = msg.content.replace(/<@!?\d+>/g, " ");						// Purge all pings. <@12345> and <@!12345> formats.
		let parts = content.split(" ").map(s => s.trim()).filter(z => z !== "");
		if (parts.length > 0 && parts[0].startsWith("!")) {
			let cmd = parts[0];
			let args = parts.slice(1);
			return {cmd, args};
		}
		return default_result;
	},

	add_base_message_to_history: function(msg) {			// i.e. for the simple content of a message, not looking for attachments.
		let o = new_history_object({
			snow_big_int: BigInt(msg.id),
			author_tag:   msg.author.tag,
			author_id:    msg.author.id,
			author_type:  user_type_from_msg(msg),
			from_me:      this.msg_is_mine(msg),
			pings_me:     this.msg_mentions_me(msg),
			text:         msg.content,						// It's a mistake to use msg.cleanContent as it trains the LLMs on wrong ping format.
			filename:     null
		});
		if (o.from_me) {
			throw new Error("add_base_message_to_history received a message from self");
		}
		this.history.push(o);
		this.truncate_history(this.history_limit);
		this.last_msg = msg;
	},

	add_attachment_to_history: function(msg, settled) {		// See attachment_fetches() for the format of "settled".
		let o = new_history_object({
			snow_big_int: BigInt(msg.id),
			author_tag:   msg.author.tag,
			author_id:    msg.author.id,
			author_type:  user_type_from_msg(msg),
			from_me:      this.msg_is_mine(msg),
			pings_me:     this.msg_mentions_me(msg),		// Note that this is being set from the msg, not the attachment contents. We want it this way.
			text:         settled.text,
			filename:     settled.filename
		});
		if (o.from_me) {
			throw new Error("add_attachment_to_history received a message from self");
		}
		this.history.push(o);
		this.truncate_history(this.history_limit);
		this.last_msg = msg;
	},

	add_own_response_to_history: function(s) {				// Just add the raw AI output to the history.
		let o = new_history_object({
			snow_big_int: BigInt(-1),
			author_tag:   this.conn.user.tag,
			author_id:    this.conn.user.id,
			author_type:  "AI",
			from_me:      true,
			pings_me:     false,							// Even if there was a self-ping, just say no.
			text:         s,
			filename:     null
		});
		this.history.push(o);
		this.truncate_history(this.history_limit);
		// Can't update this.last_msg because we aren't receiving a msg, this is our own output.
	},

	can_respond: function() {
		if (!this.channel || this.in_flight) {
			return false;
		}
		for (let o of this.history) {
			if (!o.from_me && o.snow_big_int > this.last_handled && ((o.pings_me && !this.ping_blind) || Math.random() < this.chaos)) {
				return true;
			}
		}
		// If we get here, we looked at the entire history without responding, so set this.last_handled.
		// This is necessary because chaotic bots will always have some chance to reply to older messages,
		// including on future calls to can_respond().
		this.set_all_history_handled();
		return false;
	},

	maybe_respond_spinner: function() {
		this.maybe_respond();
		this.poll_id = setTimeout(this.maybe_respond_spinner.bind(this), this.poll_wait);
	},

	maybe_respond: function() {
		if (this.can_respond()) {
			this.respond();
		}
	},

	respond: function() {

		// Regardless of what actually triggered the response, it's reasonable to consider us as reacting to the last message
		// in the history, since we see up to that point.

		let last = this.last_msg;							// Note that this is actually last-non-self-message
		if (last) {
			last.react(this.emoji);							// The patented reply reaction emoji.
		}
		this.set_all_history_handled();

		let conversation = this.format_history();

		this.sent_chars += conversation.reduce((total, s) => total + s.length, 0);
		this.sent_chars += this.ai_client.config.system_prompt.length;

		this.in_flight = "Contacting LLM";
		this.cancelled = false;
		this.ai_abortcontroller = new AbortController();

		// Promise.resolve("I would have sent something.").catch(error => {		// Use this for testing.

		this.ai_client.send_conversation(conversation, false, this.ai_abortcontroller).catch(error => {
			if (error.name !== "AbortError") {
				this.log(error);
			}
			if (this.channel) {
				// Fire and forget, but catching Discord errors. This is not propagated in the main promise chain.
				this.channel.send(error.toString().slice(0, 1999)).catch(discord_error => {
					console.log(discord_error);
				});
			}
			return null;
		}).then(response => {
			if (!response || !this.channel || this.cancelled) {
				return;
			}
			this.received_chars += response.length;
			response = helpers.normalize_linebreaks(response);			// Llama Base confused me once with \r
			this.add_own_response_to_history(response);
			let [text, attachments] = create_text_and_attachments(response);
			let chunks = helpers.split_text_into_chunks(text, 1999);
			let send_promise_chain = Promise.resolve();
			for (let i = 0; i < chunks.length - 1; i++) {	// i < chunks.length - 1 is correct, the last chunk is handled below.
				let chunk = chunks[i];
				send_promise_chain = send_promise_chain
					.then(() => this.channel.send({content: chunk}))
					.then(() => delay(2000));
			}
			return send_promise_chain.then(() => {			// Send the last chunk with all attachments
				return this.channel.send({
					content: chunks.length > 0 ? chunks[chunks.length - 1] : "",
					files: attachments
				});
			});
		}).catch(error => {
			this.log(error);								// We caught an error while sending to Discord, so we can only log it.
		}).finally(() => {
			this.in_flight = false;
			this.ai_abortcontroller = null;
			if (last && this.channel) {
				let reaction = last.reactions.cache.get(this.emoji);
				if (reaction) {
					// Note that this may sometimes fail because the cache wasn't updated fast enough. Meh.
					reaction.remove().catch(error => console.error("Failed to clear reaction:", error));
				}
			}
		});
	},

	truncate_history: function(n) {							// Ensuring the first surviving object is not from self.
		let arr = this.history.slice(-n);
		if (arr.length === 0 || !arr[0].from_me) {
			this.history = arr;
		} else {
			let first_not_from_me_index = arr.findIndex(o => !o.from_me);
			if (first_not_from_me_index === -1) {
				this.history = [];
			} else {
				this.history = arr.slice(first_not_from_me_index);
			}
		}
	},

	format_history: function() {

		// Take the history and create a new array such that every 2nd message in the new
		// array is from me, concatenating messages as required to maintain this goal.

		const SYSTEM_START = "[[ New messages received! ]]";
		const SYSTEM_END = "[[ You can reply! Please do not add system headers. ]]";

		let ret = [];
		let current_block = [];
		let reading_own_messages = false;

		const push_block = () => {					// Helper to finalize and store the current block.
			if (current_block.length > 0) {
				if (!reading_own_messages) {
					ret.push([ /* SYSTEM_START, */ ...current_block, SYSTEM_END].join("\n\n"));
				} else {
					ret.push(current_block.join("\n\n"));
				}
			}
			current_block = [];
		};

		for (let o of this.history) {
			if (o.from_me === reading_own_messages) {
				current_block.push(reading_own_messages ? o.lesser_string() : o.full_string());
			} else {
				push_block();						// The ordering here has to be exactly as follows.
				reading_own_messages = o.from_me;
				current_block.push(reading_own_messages ? o.lesser_string() : o.full_string());
			}
		}
		push_block();

		return ret;
	},

	count_concatenated_history: function() {
		if (this.history.length === 0) {
			return 0;
		}
		let n = 0;
		let reading_own_messages = false;
		for (let o of this.history) {
			if (o.from_me) {
				if (!reading_own_messages) {
					n += 1;
					reading_own_messages = true;
				}
			} else {
				if (reading_own_messages) {
					n += 1;
					reading_own_messages = false;
				}
			}
		}
		n += 1;
		return n;
	},

	history_size: function() {
		return this.format_history().reduce((sum, s) => sum + s.length, 0);
	},

	dump_history: function() {								// Prints the array more-or-less as it will be seen by the AI.
		console.log("-".repeat(100));
		console.log(helpers.centre_string(`HISTORY OF ${this.conn.user.tag}`, 100));
		console.log("-".repeat(100));
		let foo = this.format_history();					// Note that while sending it to the Discord itself might be tempting,
		for (let s of foo) {								// it would be visible to other bots and add tokens (and thus cost).
			console.log(s);
			console.log("-".repeat(100));
		}
	},

	dump_system_prompt: function() {
		this.log(this.ai_client.config.system_prompt);
	},

	log_last_input: function() {
		let o = JSON.parse(this.ai_client.last_send);		// last_send means what was sent to the AI, i.e. its input.
		let pretty = JSON.stringify(o, null, 4);
		this.log(pretty);
	},

	log_last_output: function() {
		let o = JSON.parse(this.ai_client.last_receive);	// last_receive means what was received from the AI, i.e. its output.
		let pretty = JSON.stringify(o, null, 4);
		this.log(pretty);
	},
};

// ------------------------------------------------------------------------------------------------

function msg_from_human(msg) {
	return !msg.author.bot;
}

function user_type_from_msg(msg) {
	return msg.author.bot ? "AI" : "human";
}

function attachment_fetches(msg) {								// Returns array of promises
	let ret = [];
	for (let a of msg.attachments.values()) {					// Remembering msg.attachments is a Map[]
		if (helpers.probably_text(a.contentType)) {
			let size = parseInt(a.size) || Infinity;			// If parseInt fails use Infinity
			if (size < 1024 * 32) {								// Let's use 32K limit
				ret.push(
					helpers.fetcher(a.url)
						.then(response => response.text())
						.then(t => {
							return {filename: a.name, text: t};	// This is the resolved object seen by add_attachment_to_history()
						})
						.catch(error => Promise.reject(error))
				);
			}
		}
	}
	return ret;
}

function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function check_bot_tokens(bot_configs) {
	let all = Object.create(null);
	for (let bot_cfg of bot_configs) {
		let s = fs.readFileSync(bot_cfg.bot_token_file, "utf8").trim();
		all[s] = true;
	}
	if (Object.keys(all).length !== bot_configs.length) {
		throw new Error("check_bot_tokens: Duplicate tokens detected!");
	}
}

// ------------------------------------------------------------------------------------------------

const danger = `
>  WARNING! This is a toy project and you use it at your own risk! Use of   <
>  this software on servers with untrusted members is extremely unwise, as  <
>  they absolutely will be able to run up excessive API costs. Remember     <
>  longer histories -> more expenses!                                       <
`

function splash() {
	console.log();
	console.log(`            Script date: ${helpers.format_timestamp(fs.statSync(__filename).mtime)}`);
	console.log(`     System prompt date: ${helpers.format_timestamp(fs.statSync(DEFAULT_SP_FILE).mtime)}`);
	console.log(`   LLM chaos started at: ${helpers.format_timestamp(new Date())}`);
	console.log();
	console.log(danger.trim());
	console.log();
}

// ------------------------------------------------------------------------------------------------

function main() {

	let config = JSON.parse(fs.readFileSync(CONFIG_FILE));
	let common = config.common;

	let included = config.known.filter(o => !config.disabled.includes(o.ai_config.model));

	check_bot_tokens(included);

	let bot_promises = [];

	for (let bot_cfg of included) {
		bot_promises.push(new_bot(bot_cfg, common));
	}

	Promise.all(bot_promises).then(arr => {
		bots = arr;
		for (let bot of bots) {
			bot.start();			// Requires the bots array to be finalised first as the system prompt needs it.
		}
		splash();
	});
}

main();
