"use strict";

const fs = require("fs");
const configs = require("./configs");
const { RequestError, TooManyErrors } = require("./exceptions");
const utils = require("./utils");

function new_client(cfg) {

	let client = Object.create(client_prototype);
	let tmp_config = Object.assign({}, cfg);

	for (let key of configs.Required) {
		if (!Object.hasOwn(tmp_config, key)) {
			throw new Error(`Missing required config key: ${key}`);
		}
	}

	for (let [key, value] of Object.entries(configs.Defaults)) {
		if (!Object.hasOwn(tmp_config, key)) {
			tmp_config[key] = value;
		}
	}

	for (let key of Object.keys(cfg)) {
		if (!Object.hasOwn(configs.Defaults, key)) {
			throw new Error(`Unknown config key: ${key}`);
		}
	}

	// ASAP, lets make client.config a deep copy with this crude but effective method...

	client.config = JSON.parse(JSON.stringify(tmp_config));

	// Various things, if unset, get some sort of default value or value copied from another field.
	// Do these things in the right order...!

	if (!client.config.name) {
		client.config.name = client.config.full_name || client.config.model;
	}
	if (!client.config.full_name) {
		client.config.full_name = client.config.name;
	}
	if (!client.config.company) {
		client.config.company = "Unknown Company";
	}

	let api_key = "unset";								// Closure technique to keep api_key secret.
	client.get_api_key = () => api_key;
	client.set_api_key = (s) => {
		api_key = s;
	};

	client.errors = 0;
	client.delay = client.config.min_delay;				// In seconds. Will need to be multiplied by 1000.
	client.next_permitted_send = 0;						// Based on performance.now(), using milliseconds.

	client.standard_system_prompt_replacements();

	client.last_send = null;
	client.last_receive = null;

	client.output_token_method = "";					// An info string of how output tokens are being counted.

	return client;
}

const client_prototype = {

	set_api_key_from_file: function(filepath) {
		let key = fs.readFileSync(filepath, "utf8");
		this.set_api_key(key.trim());
	},

	set_system_prompt: function(s) {
		this.config.system_prompt = s.trim();
		this.standard_system_prompt_replacements();
	},

	set_system_prompt_from_file: function(filepath) {
		let s = fs.readFileSync(filepath, "utf8");
		this.set_system_prompt(s.replaceAll("\r\n", "\n"));		// Fix Windows newlines.
	},

	standard_system_prompt_replacements: function() {
		let now = new Date();
		let date_str = now.toLocaleDateString("en-US", {weekday: "long", month: "long", day: "numeric", year: "numeric"});
		this.replace_in_system_prompt("{{currentDateTime}}", date_str, true);
		this.replace_in_system_prompt("{{name}}", this.config.name, true);
		this.replace_in_system_prompt("{{company}}", this.config.company, true);
		this.replace_in_system_prompt("{{fullName}}", this.config.full_name, true);
	},

	replace_in_system_prompt: function(search, replace, allow_non_extant = false) {
		if (!allow_non_extant && !this.config.system_prompt.includes(search)) {
			throw new Error("replace_in_system_prompt: search string not present");
		}
		this.config.system_prompt = this.config.system_prompt.replaceAll(search, replace);
	},

	set_max_tokens: function(n) {
		this.config.max_tokens = n;
	},

	set_temperature: function(n) {
		this.config.temperature = n;
	},

	set_max_errors: function(n) {
		this.config.max_errors = n;
	},

	set_reasoning_effort: function(s) {
		if (this.is_anthropic() || this.is_google()) {		// reasoning_effort is the OpenAI name, but we can use this hacky translation...
			this.set_budget_tokens(s === "high" ? 8192 : (s === "medium" ? 3072 : (s === "low" ? 1024 : 0)));
		} else {
			this.config.reasoning_effort = s;
		}
	},

	set_budget_tokens: function(n) {
		this.config.budget_tokens = n;
	},

	register_success: function() {
		this.delay = utils.clamp(this.config.min_delay, this.delay / 2, this.config.max_delay);
	},

	register_failure: function() {
		this.delay = utils.clamp(this.config.min_delay, this.delay * 2, this.config.max_delay);
		this.next_permitted_send = performance.now() + (this.delay * 1000);
		this.errors += 1;
	},

	send_message: function(message, abortcontroller = null) {
		return this.send_conversation([message], false, abortcontroller);
	},

	is_anthropic: function() {
		return this.config.url.toUpperCase().includes("ANTHROPIC");
	},

	is_google: function() {
		return this.config.url.toUpperCase().includes("GOOGLE");
	},

	is_openrouter: function() {
		return this.config.url.toUpperCase().includes("OPENROUTER");
	},

	is_openai_chat_api: function() {
		return this.config.url.toUpperCase().includes("OPENAI") && this.config.url.toUpperCase().includes("CHAT/COMPLETIONS");
	},

	is_openai_responses_api: function() {
		return this.config.url.toUpperCase().includes("OPENAI") && this.config.url.toUpperCase().includes("RESPONSES");
	},

	handle_429: function(response) {
		let retry_header = response.headers.get("retry-after");		// .get() works in a case-insensitive way
		if (retry_header) {
			let retry_float = parseFloat(retry_header);
			if (!Number.isNaN(retry_float)) {
				this.next_permitted_send = performance.now() + (retry_float * 1000);
			}
		}
	},

	anthropic_request: function(formatted_conversation) {
		let headers = {
			"x-api-key": this.get_api_key(),
			"anthropic-version": this.config.anthropic_version,
			"content-type": "application/json",
		};

		let data = {
			model: this.config.model,
			messages: formatted_conversation,
			[this.config.max_tokens_key]: this.config.max_tokens,
		};

		if (this.config.system_prompt) {
			data.system = this.config.system_prompt;
		}

		if (this.config.temperature >= 0) {
			data.temperature = this.config.temperature;
		}

		if (this.config.budget_tokens > 0) {
			data.thinking = {
				budget_tokens: this.config.budget_tokens,
				type: "enabled"
			};
		}

		return [headers, data];
	},

	openai_chat_api_request: function(formatted_conversation) {
		let headers = {
			"authorization": `Bearer ${this.get_api_key()}`,
			"content-type": "application/json",
		};

		let data = {
			model: this.config.model,
			messages: formatted_conversation,
			[this.config.max_tokens_key]: this.config.max_tokens,
			store: false,
		};

		if (this.config.system_prompt) {				// For OpenAI, System prompt is first message.
			data.messages.unshift({
				role: this.config.sp_role,
				content: this.config.system_prompt
			});
			if (this.config.sp_role === "user") {		// If it's a "user" message, add a simple reply to keep [user, assistant] pattern.
				data.messages.splice(1, 0, {
					role: "assistant",
					content: "OK, I understood these instructions and I am ready to proceed!"
				});
			}
		}

		if (this.config.temperature >= 0) {
			data.temperature = this.config.temperature;
		}

		if (this.config.reasoning_effort) {
			data.reasoning_effort = this.config.reasoning_effort;
		}

		return [headers, data];
	},

	openai_responses_api_request: function(formatted_conversation) {
		let headers = {
			"authorization": `Bearer ${this.get_api_key()}`,
			"content-type": "application/json",
		};

		let data = {
			model: this.config.model,
			input: formatted_conversation,
			[this.config.max_tokens_key]: this.config.max_tokens,
			store: false,
		};

		if (this.config.system_prompt) {				// System prompt is first message.
			data.input.unshift({
				role: this.config.sp_role,
				content: this.config.system_prompt
			});
			if (this.config.sp_role === "user") {		// If it's a "user" message, add a simple reply to keep [user, assistant] pattern.
				data.input.splice(1, 0, {
					role: "assistant",
					content: "OK, I understood these instructions and I am ready to proceed!"
				});
			}
		}

		if (this.config.temperature >= 0) {
			data.temperature = this.config.temperature;
		}

		if (this.config.reasoning_effort) {
			data.reasoning = {
				effort: this.config.reasoning_effort,
				// summary: "auto",						// Can't do this on OpenAI without being verified.
			};
		}

		if (Array.isArray(this.config.tools) && this.config.tools.length > 0) {
			data.tools = this.config.tools;
		}

		return [headers, data];
	},

	openrouter_request: function(formatted_conversation) {
		let headers = {
			"authorization": `Bearer ${this.get_api_key()}`,
			"content-type": "application/json",
		};

		let data = {
			model: this.config.model,
			messages: formatted_conversation,
			[this.config.max_tokens_key]: this.config.max_tokens,
		};

		if (this.config.system_prompt) {				// System prompt is first message.
			data.messages.unshift({
				role: this.config.sp_role,
				content: this.config.system_prompt
			});
			if (this.config.sp_role === "user") {		// If it's a "user" message, add a simple reply to keep [user, assistant] pattern.
				data.messages.splice(1, 0, {
					role: "assistant",
					content: "OK, I understood these instructions and I am ready to proceed!"
				});
			}
		}

		if (this.config.temperature >= 0) {
			data.temperature = this.config.temperature;
		}

		if (this.config.reasoning_effort) {
			data.reasoning = {effort: this.config.reasoning_effort};		// Note this is like OpenAI responses API.
		}

		if (Array.isArray(this.config.openrouter_order) && this.config.openrouter_order.length > 0) {
			data.provider = {
				order: this.config.openrouter_order,
				allow_fallbacks: false,
			};
		}

		return [headers, data];
	},

	google_request: function(formatted_conversation) {
		let headers = {
			"x-goog-api-key": this.get_api_key(),
			"content-type": "application/json",
		};

		let data = {
			contents: formatted_conversation,
			generationConfig: {
				[this.config.max_tokens_key]: this.config.max_tokens,
				thinkingConfig: {
					includeThoughts: true
				}
			}
		};

		if (this.config.budget_tokens > 0) {
			data.generationConfig.thinkingConfig.thinkingBudget = this.config.budget_tokens;
		}

		if (this.config.system_prompt) {
			data.system_instruction = {
				parts: [{ text: this.config.system_prompt }]
			};
		}

		if (this.config.temperature >= 0) {
			data.generationConfig.temperature = this.config.temperature;
		}

		return [headers, data];
	},

	get_handlers: function() {

		if (this.is_openrouter()) return {
			formatter: utils.format_message_array_standard,
			maker:     this.openrouter_request.bind(this),
			parser:    utils.parse_200_response_openai_chat_api
		};

		if (this.is_anthropic()) return {
			formatter: utils.format_message_array_standard,
			maker:     this.anthropic_request.bind(this),
			parser:    utils.parse_200_response_anthropic
		};

		if (this.is_google()) return {
			formatter: utils.format_message_array_google,
			maker:     this.google_request.bind(this),
			parser:    utils.parse_200_response_google
		};

		if (this.is_openai_chat_api()) return {
			formatter: utils.format_message_array_standard,
			maker:     this.openai_chat_api_request.bind(this),
			parser:    utils.parse_200_response_openai_chat_api
		};

		if (this.is_openai_responses_api()) return {
			formatter: utils.format_message_array_standard,
			maker:     this.openai_responses_api_request.bind(this),
			parser:    utils.parse_200_response_openai_responses_api
		};

		// Standard... is currently just the same as OpenAI Chat API:

		return {
			formatter: utils.format_message_array_standard,
			maker:     this.openai_chat_api_request.bind(this),
			parser:    utils.parse_200_response_openai_chat_api
		};
	},

	prepare_request: function(conversation, raw) {				// raw flag means conversation is preformatted
		let { formatter, maker } = this.get_handlers();
		return maker(raw ? conversation : formatter(conversation));
	},

	parse_200_response: function(data) {
		let { parser } = this.get_handlers();
		return parser(data);
	},

	get_last_think: function() {
		try {
			let o = this.last_receive;
			if (this.is_anthropic()) {
				let thoughts = o.content.filter(z => z.type === "thinking").map(z => z.thinking);
				return thoughts.join("\n\n");
			} else if (this.is_openrouter()) {
				return o.choices[0].message.reasoning.trim() || "";
			} else if (this.is_google()) {
				let thoughts = o.candidates[0].content.parts.filter(z => z.thought && typeof z.text === "string").map(z => z.text);
				return thoughts.join("\n\n");
			} else {
				return o.choices[0].message.reasoning_content.trim() || "";
			}
		} catch (error) {									// i.e. something was non-existant or the wrong type
			return "";
		}
	},

	get_last_input_token_count: function() {				// The || 0 below is for the slight chance of NaN
		try {
			let o = this.last_receive;
			if (typeof o?.usage?.input_tokens === "number") {							// Anthropic and OpenAI "responses" format
				return o.usage.input_tokens || 0;
			}
			if (typeof o?.usageMetadata?.promptTokenCount === "number") {				// Google format
				return o.usageMetadata.promptTokenCount || 0;
			}
			if (typeof o?.usage?.prompt_tokens === "number") {							// OpenAI "chat completion" format
				return o.usage.prompt_tokens || 0;
			}
			return 0;
		} catch (error) {
			return 0;
		}
	},

	get_last_output_token_count: function() {				// The || 0 below is for the slight chance of NaN
		try {
			let o = this.last_receive;
			// Avoid some bugs (untrustworthy output token counts) by using total tokens minus prompt tokens...
			if (typeof o?.usage?.total_tokens === "number" && typeof o?.usage?.prompt_tokens === "number") {
				this.output_token_method = "total_tokens - prompt_tokens";
				return o.usage.total_tokens - o.usage.prompt_tokens || 0;
			}
			if (typeof o?.usage?.total_tokens === "number" && typeof o?.usage?.input_tokens === "number") {
				this.output_token_method = "total_tokens - input_tokens";
				return o.usage.total_tokens - o.usage.input_tokens || 0;
			}
			// Otherwise...
			if (typeof o?.usage?.output_tokens === "number") {							// Anthropic and OpenAI "responses" format
				this.output_token_method = "output_tokens";
				return o.usage.output_tokens || 0;
			}
			if (typeof o?.usageMetadata?.candidatesTokenCount === "number") {			// Google format
				this.output_token_method = "candidatesTokenCount + thoughtsTokenCount";
				let cand_tokens = o.usageMetadata.candidatesTokenCount || 0;
				let think_tokens = o.usageMetadata.thoughtsTokenCount || 0;
				return cand_tokens + think_tokens || 0;
			}
			if (typeof o?.usage?.completion_tokens === "number") {						// OpenAI "chat completion" format
				this.output_token_method = "completion_tokens";
				return o.usage.completion_tokens || 0;
			}
			this.output_token_method = "couldn't find data";
			return 0;
		} catch (error) {
			this.output_token_method = "error";
			return 0;
		}
	},

	send_conversation: function(conversation, raw = false, abortcontroller = null) {

		this.last_send = null;
		this.last_receive = null;

		if (this.errors > this.config.max_errors) {
			return Promise.reject(new TooManyErrors());
		}

		if (!Array.isArray(conversation)) {
			return Promise.reject(new Error("send_conversation: conversation must be an array"));
		}

		if (!raw && conversation.length % 2 !== 1) {
			console.warn("[Warning: even number of conversation entries]");
		}

		if (this.config.system_prompt.includes("{{") &&
			this.config.system_prompt.includes("}}")) {
			console.warn("[Warning: probable {{placeholder}} text in system prompt]");
		}

		let delay_promise;
		let t = performance.now();

		if (t < this.next_permitted_send) {
			delay_promise = new Promise(resolve => setTimeout(resolve, this.next_permitted_send - t));
		} else {
			delay_promise = Promise.resolve();
		}

		return delay_promise.then(() => {
			let [headers, data] = this.prepare_request(conversation, raw);
			this.last_send = data;
			return fetch(this.config.url, {
				method: "POST",
				headers: headers,
				body: JSON.stringify(data),
				signal: abortcontroller?.signal,
			});
		}).catch(error => {
			this.register_failure();
			throw error;
		}).then(response => {
			if (response.status !== 200) {
				this.register_failure();				// BEFORE the following, as both set .next_permitted_send, but the next one must prevail.
				if (response.status === 429) {
					this.handle_429(response);
				}
				return response.text().then(text => {
					throw new RequestError(response.status, text);
				});
			} else {
				return response.json().then(data => {
					this.last_receive = data;
					return this.parse_200_response(data);
				}).then(result => {						// result is a string.
					this.register_success();
					return result;						// Thus the overall promise resolves to a string.
				}).catch(error => {
					this.register_failure();
					throw error;
				});
			}
		});
	},
};

module.exports = new_client;
