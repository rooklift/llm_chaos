"use strict";

const { RequestError } = require("./exceptions");

exports.clamp = function(low, val, high) {
	if (val < low) return low;
	if (val > high) return high;
	return val;
};

exports.parse_200_response_openai = function(data) {
	let content = data?.choices?.[0]?.message?.content;
	if (typeof content !== "string") {
		throw new RequestError(200, JSON.stringify(data));
	}
	return content;
};

exports.parse_200_response_openrouter = function(data, show_reasoning = false) {
	let content = data?.choices?.[0]?.message?.content;
	if (typeof content !== "string") {
		throw new RequestError(200, JSON.stringify(data));
	}
	let reasoning = data?.choices?.[0]?.message?.reasoning;
	if (show_reasoning && typeof reasoning === "string" && reasoning.length > 0) {
		return "<think>\n" + reasoning.trim() + "\n</think>\n\n" + content;
	} else {
		return content;
	}
};

exports.parse_200_response_google = function(data) {
	let parts = data?.candidates?.[0]?.content?.parts;
	if (!Array.isArray(parts) || parts.length === 0) {
		throw new RequestError(200, JSON.stringify(data));
	}
	let ret_strings = parts.map(part => {
		return part?.text || "[response content included unreadable part]";		// part?.text because part could be null I guess.
	});
	return ret_strings.join("\n\n");
};

exports.parse_200_response_anthropic = function(data, show_reasoning = false) {
	if (!Array.isArray(data.content) || data.content.length === 0) {
		throw new RequestError(200, JSON.stringify(data));
	}
	let ret_strings = [];
	let thinking = null;
	for (let part of data.content) {
		if (typeof part !== "object" || part === null || !Object.hasOwn(part, "type")) {
			ret_strings.push(`[response content included unreadable part]`);
		} else if (part.type === "thinking" && typeof part.thinking === "string") {
			thinking = part.thinking;
		} else if (part.type === "redacted_thinking") {
			continue;
		} else if (part.type === "text" && typeof part.text === "string") {
			ret_strings.push(part.text);
		} else {
			ret_strings.push(`[response content included unreadable "${part.type}" part]`);
		}
	}
	if (thinking && show_reasoning) {
		ret_strings.unshift("<think>\n" + thinking.trim() + "\n</think>");
	}
	return ret_strings.join("\n\n");
};

exports.format_message_array_openai = function(conversation) {
	if (!Array.isArray(conversation)) {
		throw new Error("format_message_array_openai: conversation must be an array");
	}

	let ret = [];
	let role = "user";

	for (let text of conversation) {
		if (typeof text !== "string") {
			throw new Error("format_message_array_openai: conversation contained non-string entry");
		}
		ret.push({ role: role, content: text });
		role = role === "user" ? "assistant" : "user";
	}

	return ret;
};

exports.format_message_array_google = function(conversation) {
	if (!Array.isArray(conversation)) {
		throw new Error("format_message_array_google: conversation must be an array");
	}

	let ret = [];
	let role = "user";

	for (let text of conversation) {
		if (typeof text !== "string") {
			throw new Error("format_message_array_google: conversation contained non-string entry");
		}
		ret.push({ role: role, parts: [{ text: text }] });
		role = role === "user" ? "model" : "user";
	}

	return ret;
};
