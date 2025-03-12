"use strict";

const ai = require("./ai");
const discord = require("discord.js");
const fs = require("fs");
const helpers = require("./chaos_helpers");
const manager = require("./chaos_manager");
const path = require("path");

process.chdir(__dirname);

const CONFIG_FILE = "./config.json";
const STEGANOGRAPHY_PREFIXES = ["💭"];		// Any message starting with one of these is ignored.
const CHAR_TOKEN_RATIO = 3.6;				// For token estimates and cost estimates.
const DEFAULT_BUDGET = 50;					// Won't do anything if prices aren't accurately set in the config.

// ------------------------------------------------------------------------------------------------

let bots = [];
let budget = 0;
let ever_sent_budget_error = false;

// ------------------------------------------------------------------------------------------------
// History objects storing only essential info out of a discord message, needed by the LLMs.

function new_history_object(opts) {
	let required = ["snow_big_int", "author_name", "author_id", "author_type", "from_me", "pings_me", "text", "filename"];
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
	return `### Message from ${o.author_name} (${o.author_type}, userid ${o.author_id}):\n`;
}

function attachment_system_header(o) {
	return `### File attached by ${o.author_name} (${o.author_type}, userid ${o.author_id}):\n`;
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

	return [text.trim(), built_arr];
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

				ai_client: null,														// Connection to the LLM via the ai library.
				conn: null,																// Connection to Discord.

				top_header: cfg.top_header ?? common.top_header ?? "",					// System header to include at start of a foreign message block.
				end_header: cfg.end_header ?? common.end_header ?? "",					// System header to include at end of a foreign message block.

				owner: common.owner,													// Human in charge, for S.P. (use owner_id for important stuff)
				owner_id: common.owner_id ?? "",										// And their Discord ID as a string
				chaos: cfg.chaos ?? common.chaos ?? 0,									// Chance of responding randomly to a non-ping.
				emoji: cfg.emoji ?? common.emoji ?? "💡",								// Emoji used to acknowledge receipt of message.
				sp_location: cfg.system_prompt ?? common.system_prompt ?? "",			// Location of the system prompt, for (re)loading.
				ping_blind: cfg.ping_blind ?? common.ping_blind ?? false,				// Whether this LLM's ping recognition is suppressed.
				show_reasoning: cfg.show_reasoning ?? common.show_reasoning ?? true,	// Whether thinking blocks are shown (if available).
				history_limit: cfg.history_limit ?? common.history_limit ?? 50,			// Max history length.
				poll_wait: cfg.poll_wait ?? common.poll_wait ?? 20000,					// Delay for maybe_respond_spinner().
				restricted: cfg.restricted ?? false,									// Only the owner can cause a reply.
				input_price: cfg.input_price ?? 0,										// Expressed as dollars per million tokens.
				output_price: cfg.output_price ?? 0,									// Note that there are issues with not counting reasoning tokens.

				sent_tokens: 0,															// Count, usually based on actual metadata in response JSON.
				received_tokens: 0,														// Likewise.
				token_count_accurate: true,												// Becomes false if we ever rely on estimates (except due to errors).

				poll_id: null,															// setTimeout id, for cancellation.
				history: [],															// Using only history_objects as defined above.
				queue: [],																// Messages (as Discord objects) waiting to be processed.
				channel: null,															// The actual channel object, hopefully safe to store?
				in_flight: false,														// http request in progress to LLM? (Only to LLM now.)
				ai_abortcontroller: null,												// AbortController for cancelling LLM requests only.
				abort_count: 0,															// Used to know when we should cancel / disregard results.
				last_msg: null,															// Last message received. Purely for emoji reactions.
				last_handled: BigInt(-1),												// Snowflake (as BigInt) of the last thing we responsed to.

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
			"!budget":    [(msg, ...args) =>     this.set_dollar_budget(msg, ...args), "Set the budget in dollars."                                        ],
			"!chaos":     [(msg, ...args) =>             this.set_chaos(msg, ...args), "Set chaos value (chance of responding to non-pings)."              ],
			"!config":    [(msg, ...args) =>           this.send_config(msg, ...args), "Display LLM config in this channel."                               ],
			"!cost":      [(msg, ...args) =>             this.send_cost(msg, ...args), "Display estimated costs in this channel."                          ],
			"!costs":     [(msg, ...args) =>             this.send_cost(msg, ...args), "Alias for !cost."                                                  ],
			"!disconnect":[(msg, ...args) =>            this.disconnect(msg, ...args), "Just like it sounds."                                              ],
			"!effort":    [(msg, ...args) =>  this.set_reasoning_effort(msg, ...args), "Set reasoning effort (low / medium / high). Leave blank to clear." ],
			"!help":      [(msg, ...args) =>                       help(msg, ...args), "Display this message."                                             ],
			"!history":   [(msg, ...args) =>          this.dump_history(msg, ...args), "Dump the internal history to the console."                         ],
			"!input":     [(msg, ...args) =>        this.log_last_input(msg, ...args), "Dump the last body sent to the LLM's API to the console."          ],
			"!lock":      [(msg, ...args) =>     this.set_max_lock_time(msg, ...args), "Set the system-wide max_lock_time."                                ],
			"!lockbuffer":[(msg, ...args) =>  this.set_lock_buffer_time(msg, ...args), "Set the system-wide lock_buffer_time."                             ],
			"!manager":   [(msg, ...args) =>    this.send_manager_debug(msg, ...args), "Display the state of the manager in this channel."                 ],
			"!memory":    [(msg, ...args) =>     this.set_history_limit(msg, ...args), "Set the number of messages saved in the history."                  ],
			"!output":    [(msg, ...args) =>       this.log_last_output(msg, ...args), "Dump the last body received from the LLM's API to the console."    ],
			"!poll":      [(msg, ...args) =>         this.set_poll_wait(msg, ...args), "Set the polling delay in milliseconds."                            ],
			"!reload":    [(msg, ...args) =>     this.set_system_prompt(msg, ...args), "Reload the system prompt from disk."                               ],
			"!reset":     [(msg, ...args) =>                 this.reset(msg, ...args), "Clear the history. Make the LLM use this channel."                 ],
			"!show":      [(msg, ...args) =>    this.set_show_reasoning(msg, ...args), "Set / toggle showing reasoning (if available) in the channel."     ],
			"!status":    [(msg, ...args) =>           this.send_status(msg, ...args), "Display essential bot status info in this channel."                ],
			"!system":    [(msg, ...args) =>    this.dump_system_prompt(msg, ...args), "Dump the system prompt to the console."                            ],
			"!tokens":    [(msg, ...args) =>        this.set_max_tokens(msg, ...args), "Set max_tokens for the LLM."                                       ],
			};

			let broadcast_commands = ["!abort", "!break", "!reset"];		// Commands that can be sent untargetted.
			let hidden_commands = ["!abort", "!costs"];						// Commands that won't show up in help. (Aliases.)

			let help = (msg) => {
				let st = ["```\nNormal commands - ping the LLM:\n"];
				for (let [key, value] of Object.entries(commands)) {
					if (!broadcast_commands.includes(key) && !hidden_commands.includes(key)) {
						st.push(`  ${key.padEnd(14)} ${value[1].toString()}`);
					}
				}
				st.push("\nChannel commands - can optionally send without ping, to affect every LLM:\n");
				for (let [key, value] of Object.entries(commands)) {
					if (broadcast_commands.includes(key) && !hidden_commands.includes(key)) {
						st.push(`  ${key.padEnd(14)} ${value[1].toString()}`);
					}
				}
				st.push("```");
				this.msg_reply(msg, st.join("\n"));
			};

			this.conn.on("messageCreate", (msg) => {
				if (this.msg_is_mine(msg)) {					// Totally ignore own messages.
					return;
				}
				for (let prefix of STEGANOGRAPHY_PREFIXES) {	// Ignore any message starting with these - important for ignoring thinking.
					if (msg.content.startsWith(prefix)) {
						return;
					}
				}
				let {cmd, args} = this.cmd_from_msg(msg);
				if (Object.hasOwn(commands, cmd)) {
					if (this.msg_mentions_me(msg) || (broadcast_commands.includes(cmd) && !this.msg_mentions_others(msg))) {
						try {
							commands[cmd][0](msg, ...args);
						} catch (error) {
							msg.channel.send(`Immediate exception: ${error}`).catch(error2 => {
								console.log(error2);
							});
						}
						return;
					}
				}
				if (cmd === "!private" && !this.msg_mentions_me(msg)) {
					return;
				}
				if (this.restricted && this.msg_mentions_me(msg) && msg.author.id !== this.owner_id) {
					this.msg_reply(msg, "Error: use of this model is restricted.");		// But it still gets added to queue.
				}
				this.queue.push(msg);
			});

			this.conn.login(fs.readFileSync(cfg.bot_token_file, "utf8"));
		});
	},

	start: function() {
		this.set_system_prompt();
		this.maybe_respond_spinner();
		this.process_queue_spinner();
	},

	disconnect: function(msg = null) {
		this.channel = null;
		this.abort();
		if (msg) {
			return msg.channel.send("Leaving the server! Goodbye.").catch(error => {
				// pass
			}).then(() => {
				return this.conn.destroy();
			}).catch(error => {
				console.log(error);
			});
		} else {
			return this.conn.destroy();
		}
	},

	disconnect_silent: function() {
		this.channel = null;
		this.abort();
		return this.conn.destroy();							// Which is a promise.
	},

	set_system_prompt: function(msg = null) {

		if (!this.sp_location) {
			return;											// Should we actually clear it in this case?
		}

		let all_llm_info = [];

		for (let bot of bots) {

			let company = bot.ai_client.config.company;
			let dname = bot.conn.user.displayName;
			let id = bot.conn.user.id;

			let special = [];
			if (bot.chaos > 0) special.push("chaotic");
			if (bot.ping_blind) special.push("ping-blind");
			let special_string = special.length ? `  <-- special flags: ${special.join(", ")}` : "";

			all_llm_info.push(`${bot.ai_client.config.full_name} created by ${company}, username ${dname} -- ping with <@${id}>${special_string}`);
		}

		let system_header_example = normal_system_header({author_name: "exampleuser", author_type: "human", author_id: "1234567890"}).trim();

		this.ai_client.set_system_prompt_from_file(this.sp_location);
		this.ai_client.replace_in_system_prompt("{{userName}}", this.conn.user.displayName, true);
		this.ai_client.replace_in_system_prompt("{{userId}}", this.conn.user.id, true);
		this.ai_client.replace_in_system_prompt("{{systemHeaderExample}}", system_header_example, true);
		this.ai_client.replace_in_system_prompt("{{modelsInTheServer}}", all_llm_info.join("\n"), true);
		this.ai_client.replace_in_system_prompt("{{serverOwner}}", this.owner, true);

		if (msg) {
			let len = this.ai_client.config.system_prompt.length / CHAR_TOKEN_RATIO;
			this.msg_reply(msg, `Reloaded approx ${len.toFixed(0)} tokens from \`${path.basename(this.sp_location)}\``);
		}
	},

	process_queue: function() {

		let mentioned_in_simple_msg = false;

		while (this.queue.length > 0) {
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
			if (msg.attachments.size === 0) {
				this.add_base_message_to_history(msg);
				if (msg_from_human(msg) && this.msg_mentions_me(msg)) {
					mentioned_in_simple_msg = true;
				}
			} else {
				this.process_msg_with_attachments(msg);		// msg not added to the history until attachments are retrieved.
			}
		}

		if (mentioned_in_simple_msg) {
			this.maybe_respond();
		}
	},

	process_queue_spinner: function() {
		this.process_queue();
		setTimeout(this.process_queue_spinner.bind(this), 250);
	},

	process_msg_with_attachments: function(msg) {

		let abort_count = this.abort_count;
		let all_fetches = attachment_fetches(msg);			// See that function for the format of the resolved values.

		Promise.allSettled(all_fetches).then(results => {
			if (this.abort_count > abort_count) {
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
			if (msg_from_human(msg) && this.msg_mentions_me(msg)) {		// Try to respond instantly if it's a human ping.
				this.maybe_respond();
			}
		});
	},

	log: function(...args) {
		console.log(this.conn.user.displayName, ...args);	// Seems to work even if args is length 0.
	},

	reset: function(msg) {
		this.channel = msg.channel;							// Hopefully OK to hold a reference to.
		this.history = [];
		this.abort(msg);
	},

	msg_reply: function(msg, s) {							// Helper to send a reply to a msg, as a fire-and-forget action.
		msg.channel.send(s).catch(error => {
			console.log(error);
		});
	},

	set_dollar_budget: function(msg, val) {
		let n = parseFloat(val);
		if (msg.author.id !== this.owner_id) {
			this.msg_reply(msg, "Unauthorised attempt to change budget!");
		} else if (Number.isNaN(n) || n < 0) {
			this.msg_reply(msg, `Invalid argument (current budget: $${budget.toFixed(2)})`);
		} else {
			budget = n;										// These are
			ever_sent_budget_error = false;					// both globals
			this.msg_reply(msg, `Budget: $${n.toFixed(2)} (system-wide)`);
		}
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
			this.show_reasoning = false;
		} else if (val && ["TRUE", "ON"].includes(val.toUpperCase())) {
			this.show_reasoning = true;
		} else {
			this.show_reasoning = !this.show_reasoning;
		}
		this.msg_reply(msg, `Show reasoning: ${this.show_reasoning}`);
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

	set_max_lock_time: function(msg, val) {
		let n = parseInt(val);
		if (Number.isNaN(n) || n < 0) {
			this.msg_reply(msg, `Invalid argument (current value: ${manager.max_lock_time})`);
		} else {
			manager.set_max_lock_time(n);
			this.msg_reply(msg, `System-wide max lock time: ${n}`);
		}
	},

	set_lock_buffer_time: function(msg, val) {
		let n = parseInt(val);
		if (Number.isNaN(n) || n < 0) {
			this.msg_reply(msg, `Invalid argument (current value: ${manager.set_lock_buffer_time})`);
		} else {
			manager.set_lock_buffer_time(n);
			this.msg_reply(msg, `System-wide lock buffer time: ${n}`);
		}
	},

	abort: function(msg = null) {
		if (this.ai_abortcontroller) {
			this.ai_abortcontroller.abort(new ai.AbortError());
			this.ai_abortcontroller = null;
		}
		this.abort_count++;
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
		`Show reasoning:  ${this.show_reasoning}\n` +
		`In flight:       ${this.in_flight}\n` +
		`Poll delay:      ${this.poll_wait}\n` +
		`Queue length:    ${this.queue.length}\n` +
		`History length:  ${this.history.length} (max ${this.history_limit}) --> concats to ${this.count_concatenated_history()}\n` +
		`History size:    ${(hs / CHAR_TOKEN_RATIO).toFixed(0)} tokens + ${(spl / CHAR_TOKEN_RATIO).toFixed(0)} S.P. tokens\n` +
		"```";
		this.msg_reply(msg, s);
	},

	send_manager_debug: function(msg) {
		let s = "```\n" +
		`Manager queue:   ${manager.status()}\n` +
		`Max lock time:   ${manager.max_lock_time}\n` +
		`Lock buffer t:   ${manager.lock_buffer_time}\n` +
		"```";
		this.msg_reply(msg, s);
	},

	send_cost: function(msg) {
		let s = "```\n" +
		`I/O:             ${this.sent_tokens} tokens (input) + ${this.received_tokens} tokens (output)\n` +
		`I/O accurate:    ${this.token_count_accurate} (self) / ${bots.every(b => b.token_count_accurate)} (system)\n` +
		`Cost:            ${money_string(this.estimated_cost())}\n` +
		`All bots cost:   ${money_string(system_wide_cost())}\n` +
		`Budget:          ${money_string(budget)}\n` +
		"```";
		this.msg_reply(msg, s);
	},

	estimated_cost: function() {
		if (!this.input_price || !this.output_price) {
			return -1;
		}
		let i_cost = this.sent_tokens * this.input_price / 1000000;
		let o_cost = this.received_tokens * this.output_price / 1000000;
		return i_cost + o_cost;
	},

	msg_is_mine: function(msg) {
		return msg.author.id === this.conn.user.id;
	},

	msg_mentions_me: function(msg) {												// Makes no attempt to recognise
		return msg.mentions.users.has(this.conn.user.id);							// @everyone nor @role mentions.
	},

	msg_mentions_others: function(msg) {
		return msg.mentions.users.size >= 2 || (msg.mentions.users.size === 1 && !this.msg_mentions_me(msg));
	},

	cmd_from_msg: function(msg) {
		let default_result = {cmd: "", args: []};
		let content = msg.content.replace(/<@!?\d+>/g, " ");						// Purge all pings. <@12345> and <@!12345> formats.
		if (content > 256) {
			return default_result;
		}
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
			author_name:  msg.author.displayName,
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
			author_name:  msg.author.displayName,
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
			author_name:  this.conn.user.displayName,
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
		if (system_wide_cost() > budget) {
			if (!ever_sent_budget_error && this.channel) {
				ever_sent_budget_error = true;
				this.channel.send("Budget exceeded!").catch(error => {
					console.log(error);
				});
			}
			return false;
		}
		if (!this.channel || this.in_flight) {
			return false;
		}
		for (let o of this.history) {
			if (this.restricted && o.author_id !== this.owner_id) {
				continue;
			}
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
			return true;
		}
		return false;
	},

	respond: function() {

		// Regardless of what actually triggered the response, it's reasonable to consider us as reacting to the last message
		// in the history, since we see up to that point.

		this.in_flight = true;
		this.ai_abortcontroller = new AbortController();

		let abort_count = this.abort_count;

		// Certain variables are assigned values inside the promise chain but needed in a different scope, so declare them here:

		let last;
		let manager_lock_id;
		let sent_tokens_estimate;

		manager.request(this.conn.user.displayName).then((lock_id) => {

			manager_lock_id = lock_id;

		}).then(() => {

			// Who knows what could happen between asking for permission and getting it...

			if (!this.channel || this.abort_count > abort_count || this.history.length === 0 || this.history[this.history.length - 1].from_me) {
				return null;
			}

			last = this.last_msg;
			if (last) {
				last.react(this.emoji).catch(error => console.error("Failed to add reaction:", error));
			}

			this.set_all_history_handled();
			let conversation = this.format_history();

			let sent_chars_estimate = conversation.reduce((total, s) => total + s.length, 0) + this.ai_client.config.system_prompt.length;
			sent_tokens_estimate = Math.floor(sent_chars_estimate / CHAR_TOKEN_RATIO);
			this.sent_tokens += sent_tokens_estimate;		// But we might undo this if we can get the real value later.

			return this.ai_client.send_conversation(conversation, false, this.ai_abortcontroller);

		}).catch(error => {

			if (error.name !== "AbortError") {
				this.log(error);
			}
			if (this.channel) {
				this.channel.send(error.toString().slice(0, 1999)).catch(discord_error => {		// Not part of main promise chain.
					console.log(discord_error);
				});
			}
			return null;

		}).then(response => {

			if (typeof response !== "string" || !this.channel || this.abort_count > abort_count) {
				return null;
			}

			response = response.trim();
			response = helpers.normalize_linebreaks(response);							// Llama Base confused me once with \r

			if (response) {
				this.add_own_response_to_history(response);
			}

			let think_chunks = [];
			let main_chunks = [];

			// Any think chunks to save?

			let think = this.ai_client.get_last_think();								// think will be "" if not available.
			if (think) {
				think_chunks = helpers.split_text_into_chunks(think, 1970);				// Some margin of characters to add stuff.
				for (let i = 0; i < think_chunks.length; i++) {
					think_chunks[i] = "💭\n```\n" + think_chunks[i] + "\n```";			// 💭 at start of every chunk so other bots ignore it.
				}
				think_chunks[think_chunks.length - 1] += "\n⇨";							// Only at the end of the last think chunk.
			}

			// Any main chunks to save? Any attachments?

			let [text, attachments] = create_text_and_attachments(response);
			main_chunks = helpers.split_text_into_chunks(text, 1999);

			// Bookkeeping for costs - get real token counts from the client...
			// Have to do this after making the think var.

			let accurate_sent_tokens = this.ai_client.get_last_input_token_count();
			if (accurate_sent_tokens) {
				this.sent_tokens -= sent_tokens_estimate;								// Undo what we estimated earlier.
				this.sent_tokens += accurate_sent_tokens;
			} else {
				this.token_count_accurate = false;
			}

			let accurate_received_tokens = this.ai_client.get_last_output_token_count();
			if (accurate_received_tokens) {
				this.received_tokens += accurate_received_tokens;
			} else {
				this.received_tokens += Math.floor((think.length + response.length) / CHAR_TOKEN_RATIO);
				this.token_count_accurate = false;
			}

			// Finalise our actual chunks which we are actually sending...

			let chunks = [];
			if (this.show_reasoning) {
				chunks.push(...think_chunks);
			}
			chunks.push(...main_chunks);

			if (think_chunks.length === 0 && main_chunks.length === 0 && attachments.length === 0) {
				chunks.push("(Middleware received no thinking, no response, and no attachments)");
			} else if (think_chunks.length > 0 && main_chunks.length === 0 && attachments.length === 0) {
				chunks.push("(Middleware received only thinking)");
			}

			// Now, send all the chunks off...

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

			manager.release(manager_lock_id);
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

		let ret = [];
		let current_block = [];
		let reading_own_messages = false;

		const push_block = () => {					// Helper to finalize and store the current block.
			if (current_block.length > 0) {
				if (!reading_own_messages) {
					if (this.top_header) current_block.unshift(this.top_header);
					if (this.end_header) current_block.push(this.end_header);
					ret.push(current_block.join("\n\n"));
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
		console.log(helpers.centre_string(`HISTORY OF ${this.conn.user.displayName}`, 100));
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
		this.log(JSON.stringify(this.ai_client.last_send, null, 4));
	},

	log_last_output: function() {
		this.log(JSON.stringify(this.ai_client.last_receive, null, 4));
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
				);
			}
		}
	}
	return ret;
}

function system_wide_cost() {
	let costs = bots.map(b => b.estimated_cost()).filter(n => n > 0);
	let total = costs.reduce((sum, c) => sum + c, 0);
	return total;
}

function money_string(cost) {		// With the special case that unknown values are sent as negative.
	if (cost < 0) {
		return "Unknown!";
	}
	let s = cost.toFixed(4);
	let dot_index = s.indexOf(".");
	while (s.endsWith("0") && s.length - dot_index > 3) {
		s = s.slice(0, -1);
	}
	return "$" + s;
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
>  longer histories -> more expenses! Use the "!reset" command often.       <
`;

function splash() {
	console.log();
	console.log(`        Script modified: ${helpers.format_timestamp(fs.statSync(__filename).mtime)}`);
	console.log(`   LLM chaos started at: ${helpers.format_timestamp(new Date())}`);
	console.log();
	console.log(danger.trim());
	console.log();
}

// ------------------------------------------------------------------------------------------------

function main() {

	let config = JSON.parse(fs.readFileSync(CONFIG_FILE));
	let common = config.common;

	// Set certain global config stuff...

	if (typeof common.max_lock_time === "number") {
		manager.set_max_lock_time(common.max_lock_time);
	}
	if (typeof common.lock_buffer_time === "number") {
		manager.set_lock_buffer_time(common.lock_buffer_time);
	}
	budget = common.budget ?? DEFAULT_BUDGET;		// System-wide budget constraint. Needs accurate prices in config.

	// And start the bots...

	let included = config.known.filter(o => !Array.isArray(config.disabled) || !config.disabled.includes(o.ai_config.model));
	check_bot_tokens(included);
	let bot_promises = [];

	process.stdout.write("\n          Starting bots:");

	for (let i = 0; i < included.length; i++) {
		let bot_cfg = included[i];
		bot_promises.push(
			delay(i * 750).then(() => {				// Let's be polite and not hit the API a bunch at the same time.
				process.stdout.write(` ${i + 1}`);
				return new_bot(bot_cfg, common);
			})
		);
	}

	Promise.all(bot_promises).then(arr => {
		process.stdout.write("\n");
		bots = arr;
		for (let bot of bots) {
			bot.start();			// Requires the bots array to be finalised first as the system prompt needs it.
		}
		splash();
	});
}

function clean_exit() {

	let disco_promises = bots.map(bot => bot.disconnect_silent());

	Promise.allSettled(disco_promises).then(() => {
		console.log("   All bots disconnected.\n");
		process.exit(0);
	});

	setTimeout(() => {				// If the above takes too long...
		process.exit(0);
	}, 3000);
}

process.once("SIGINT", clean_exit);
process.once("SIGTERM", clean_exit);

main();
