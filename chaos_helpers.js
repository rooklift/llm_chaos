"use strict";

// ------------------------------------------------------------------------------------------------
// Fetcher - to avoid multiple fetches by the bots... written by Claude, mostly...

let fetcher_cache = Object.create(null);			// Holds fetch response objects
let fetcher_in_progress = Object.create(null);		// Holds fetch promises

// Remember multiple callers may get the same promise, which will resolve to
// the same response unless we do something about it. What we need to do is
// ensure each return out of this function adds a .then() which clones it.

exports.fetcher = function(url, options = {}) {

	// Must always return a promise.

	if (typeof url !== "string") {
		throw new Error("fetcher: expected string");
	}

	if (Object.hasOwn(fetcher_cache, url)) {
		return Promise.resolve(fetcher_cache[url]).then(response => response.clone());
	}

	if (Object.hasOwn(fetcher_in_progress, url)) {
		return fetcher_in_progress[url].then(response => response.clone());
	}

	let fetch_promise = fetch(url, options).then(response => {
		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}
		fetcher_cache[url] = response;
		return response;
	}).finally(() => {
		delete fetcher_in_progress[url];
	});

	fetcher_in_progress[url] = fetch_promise;

	return fetch_promise.then(response => response.clone());
};

// ------------------------------------------------------------------------------------------------

exports.split_text_into_chunks = function(text, maxlen) {			// Written by Claude.

	text = text.replace(/\n(?:\s*\n)+/g, "\n\n");

	// If text is short enough, just return it
	if (text.length <= maxlen) {
		return [text];
	}

	let chunks = [];

	// Try to split at paragraph boundaries first
	let paragraphs = text.split("\n\n");
	let current_chunk = "";

	for (let i = 0; i < paragraphs.length; i++) {
		let paragraph = paragraphs[i];

		// If a single paragraph is longer than maxlen, we'll need to split it
		if (paragraph.length > maxlen) {
			// First send the current chunk if it exists
			if (current_chunk) {
				chunks.push(current_chunk);
				current_chunk = "";
			}

			// Split long paragraph by sentences or just characters if needed
			let paragraphChunks = exports.split_paragraph(paragraph, maxlen);
			chunks = chunks.concat(paragraphChunks);
		}
		// If adding this paragraph would exceed maxlen, push current chunk and start a new one
		else if (current_chunk.length + paragraph.length + 2 > maxlen) {
			chunks.push(current_chunk);
			current_chunk = paragraph;
		}
		// Otherwise add the paragraph to the current chunk
		else {
			if (current_chunk) {
				current_chunk += "\n\n" + paragraph;
			} else {
				current_chunk = paragraph;
			}
		}
	}

	// Don't forget the last chunk
	if (current_chunk) {
		chunks.push(current_chunk);
	}

	// Ensure we return at least one chunk
	return chunks.length > 0 ? chunks : [""];
};

exports.split_paragraph = function(paragraph, maxlen) {			// Written by Claude.

	// If paragraph is short enough, just return it
	if (paragraph.length <= maxlen) {
		return [paragraph];
	}

	let chunks = [];

	// Try to split by sentences first
	let sentences = paragraph.split(/(?<=[.!?])\s+/);
	let current_chunk = "";

	for (let sentence of sentences) {
		// If single sentence is too long, we'll need to split it by characters
		if (sentence.length > maxlen) {
			// Send current chunk if it exists
			if (current_chunk) {
				chunks.push(current_chunk);
				current_chunk = "";
			}

			// Split by characters with some buffer for code blocks
			for (let i = 0; i < sentence.length; i += maxlen) {
				chunks.push(sentence.substring(i, i + maxlen));
			}
		}
		// If adding this sentence would exceed maxlen, start a new chunk
		else if (current_chunk.length + sentence.length + 1 > maxlen) {
			chunks.push(current_chunk);
			current_chunk = sentence;
		}
		// Otherwise add the sentence to current chunk
		else {
			if (current_chunk) {
				current_chunk += " " + sentence;
			} else {
				current_chunk = sentence;
			}
		}
	}

	// Don't forget the last chunk
	if (current_chunk) {
		chunks.push(current_chunk);
	}

	return chunks;
};

// ------------------------------------------------------------------------------------------------

exports.probably_text = function(content_type) {
	if (typeof content_type !== "string") {
		return false;
	}
	if (content_type.includes("charset=utf")) {
		return true;
	}
	for (let foo of ["text/", "application/json", "application/javascript", "application/x-python"]) {
		if (content_type.startsWith(foo)) {
			return true;
		}
	}
	return false;
};

exports.normalize_linebreaks = function(text) {
	text = text.replace(/\r\n/g, "\n");
	text = text.replace(/\r/g, "\n");
	return text;
};

exports.centre_string = function(s, width) {
	if (s.length >= width) {
		return s;
	}
	let total_padding = width - s.length;
	let left_padding = Math.floor(total_padding / 2);
	return " ".repeat(left_padding) + s;
};

exports.format_timestamp = function(date) {
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    const month = date.toLocaleString("en-GB", { month: "short" });
    const day = String(date.getDate()).padStart(2, "0");
    const year = date.getFullYear();
    return `${hours}:${minutes}:${seconds} on ${month} ${day}, ${year}`;
};

exports.date_from_snowflake = function(snowflake) {		// Unused but good to have.
	if (typeof snowflake === "string") {
		snowflake = BigInt(snowflake);
	}
	if (typeof snowflake !== "bigint") {
		throw new Error("date_from_snowflake: invalid argument");
	}
	let unixtime = BigInt(1420070400000) + (snowflake >> BigInt(22));
	return new Date(Number(unixtime));
};

exports.emblocken_thinks = function(s) {	// Maybe don't use this as it slightly trains other AIs (which see the output) to use Markdown blocks.

	if (!s.startsWith("<think>")) {
		return s;
	}

	let open_count = (s.match(/<think>/g) || []).length;
	let close_count = (s.match(/<\/think>/g) || []).length;
	if (open_count !== 1 || close_count !== 1) {
		return s
	}

	let i = s.indexOf("</think>");
	if (i > 1980) {						// Something like 1985 is the actual limit.
		return s;
	}

	s = s.replace("<think>", "```\n<think>")
	s = s.replace("</think>", "</think>\n```")

	// There's likely a double newline between the thinking and the content, but once
	// wrapped in a code block this will be excessive, so make it a single newline:

	s = s.replace("</think>\n```\n\n", "</think>\n```\n")

	return s;
};
