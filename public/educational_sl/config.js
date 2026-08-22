self.__engnxjet$config = {
	prefix: '/educational_apkn/',
	files: {
		wasm: '/educational_vr/engnxjet.wasm.wasm',
		all: '/educational_vr/engnxjet.all.js',
		sync: '/educational_vr/engnxjet.sync.js'
	},
	siteFlags: {
		'https://discord.com/.*': {
			naiiveRewriter: true
		}
	},
	flags: {
		captureErrors: true,
		cleanErrors: true,
		naiiveRewriter: false,
		rewriterLogs: false,
		engnxitize: false,
		serviceworkers: false,
		sourcemaps: true,
		strictRewrites: true,
		syncxhr: false
	},
	codec: {
		encode: (url) => {
			if (!url) return url;
			return encodeURIComponent(
				url
					.toString()
					.split('')
					.map((char, ind) =>
						ind % 2
							? String.fromCharCode(char.charCodeAt() ^ 2)
							: char
					)
					.join('')
			);
		},

		decode: (url) => {
			if (!url) return url;
			let [input, ...search] = url.split('?');

			return (
				decodeURIComponent(input)
					.split('')
					.map((char, ind) =>
						ind % 2
							? String.fromCharCode(char.charCodeAt(0) ^ 2)
							: char
					)
					.join('') + (search.length ? '?' + search.join('?') : '')
			);
		}
	}
};
