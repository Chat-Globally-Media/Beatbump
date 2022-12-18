/**
 * TODO: clean this module up massively.
 *
 * - Use class instead of func impl (...?)
 *
 */
import type { Item, Nullable } from "$lib/types";
import { addToQueue, getSrc, notify } from "$lib/utils";
import { Mutex } from "$lib/utils/sync";
import { splice } from "$lib/utils/collections/array";
import { writable, get } from "svelte/store";
import { playerLoading, currentTitle, filterAutoPlay } from "../stores";
import { groupSession } from "../sessions";
import type { ISessionListService, ISessionListProvider } from "./types.list";
import { fetchNext, filterList } from "./utils.list";

const mutex = new Mutex();

const SessionListService: ISessionListService = _sessionListService();

interface AutoMixArgs {
	videoId?: string;
	playlistId?: string;
	keyId?: number;
	playlistSetVideoId?: string;
	loggingContext: { vssLoggingContext: { serializedContextData: string } };
	clickTracking?: string;
	config?: { playerParams?: string; type?: string };
}

function togglePlayerLoad() {
	playerLoading.set(true);
	return () => playerLoading.set(false);
}

function _sessionListService(): ISessionListService {
	// default values for the store
	let mix: Item[] = [],
		continuation = "",
		clickTrackingParams: Nullable<string> = "",
		currentMixId = "",
		position = 0,
		currentMixType: "playlist" | "auto" | string = "",
		related = "";
	let visitorData = "";

	const { update, subscribe } = writable<ISessionListProvider>({
		mix,
		currentMixId,
		clickTrackingParams,
		continuation,
		position,
		currentMixType,
	});

	// Used when playlist session is initialized with more than 50 items
	let chunkedListOriginalLen: number;
	let chunkedPlaylistCurrentIdx = 0;
	const chunkedPlaylistMap = new Map<number, Item[]>();

	const _set = (value: ISessionListProvider) => {
		clickTrackingParams = value.clickTrackingParams ?? clickTrackingParams;
		continuation = value.continuation ?? continuation;
		currentMixId = value.currentMixId ?? currentMixId;
		mix = value.mix ? value.mix : mix;
		position = value.position ?? position;
		currentMixType = value.currentMixType ?? currentMixType;
		update((_) => (_ = { ..._, mix, position, currentMixId, continuation, clickTrackingParams, currentMixType }));
		return {
			clickTrackingParams,
			continuation,
			currentMixId,
			mix,
			position,
			currentMixType,
		};
	};
	const commitChanges = ({
		clickTrackingParams,
		mix,
		continuation,
		currentMixId,
		position,
		currentMixType,
	}: ISessionListProvider) => _set({ clickTrackingParams, mix, continuation, currentMixId, position, currentMixType });

	async function getMoreLikeThis({ playlistId }: { playlistId: Nullable<string> }) {
		if (!mix.length) {
			return;
		}
		playerLoading.set(true);

		const response = await fetchNext({
			params: "wAEB8gECeAE%3D",
			playlistId: "RDAMPL" + (playlistId !== null ? playlistId : currentMixId),
		});
		const data = await response;

		data.results.shift();

		mix.push(...data.results);

		continuation = data.continuation;

		commitChanges({ mix, clickTrackingParams, currentMixId, continuation, position, currentMixType });

		if (groupSession?.initialized && groupSession?.hasActiveSession) {
			groupSession.updateGuestTrackQueue({
				mix,
				clickTrackingParams,
				currentMixId,
				continuation,
				position,
				currentMixType,
			});
		}
		playerLoading.set(false);
	}
	return {
		subscribe,
		set: _set,
		async lockedSet(_mix: ISessionListProvider) {
			return mutex.do(() => {
				return _set(_mix);
			});
		},
		async initAutoMixSession({
			clickTracking,
			keyId = 0,
			playlistId,
			playlistSetVideoId,
			loggingContext,
			videoId,
			config: { playerParams = "", type = "" } = {},
		}) {
			try {
				playerLoading.set(true);
				if (mix.length > 0) {
					mix = [];
					clickTrackingParams = null;
				}
				currentMixType = "auto";
				const data = await fetchNext({
					params: playerParams ? playerParams : "",
					videoId,
					playlistId: playlistId ? playlistId : "",
					loggingContext: loggingContext.vssLoggingContext.serializedContextData,
					playlistSetVideoId: playlistSetVideoId ? playlistSetVideoId : "",
					clickTracking,
					configType: type,
				});
				if (!data || !Array.isArray(data["results"])) throw new Error("No results!");

				getSrc(videoId ?? data.results[keyId ?? 0].videoId, playlistId, playerParams);
				visitorData = data["visitorData"];

				currentTitle.set((Array.isArray(data.results) && data.results[keyId ?? 0]?.title) ?? undefined);
				position = keyId ?? 0;
				playerLoading.set(false);
				continuation = data.continuation && data.continuation.length !== 0 && data.continuation;
				currentMixId = data.currentMixId;
				clickTrackingParams =
					data.clickTrackingParams && data.clickTrackingParams.length !== 0 && data.clickTrackingParams;
				mix.push(...data.results);

				commitChanges({ mix, clickTrackingParams, currentMixId, continuation, position, currentMixType });
				if (groupSession?.initialized && groupSession?.hasActiveSession) {
					groupSession.expAutoMix({ mix, clickTrackingParams, currentMixId, continuation, position, currentMixType });
				}
			} catch (err) {
				playerLoading.set(false);
				console.error(err);
			}
		},
		async initPlaylistSession(args) {
			let {
				playlistId = "",
				index = 0,
				clickTrackingParams = "",
				params = "",
				videoId = "",
				playlistSetVideoId = "",
				visitorData = "",
			} = args;
			playerLoading.set(true);

			if (currentMixType !== "playlist" || currentMixId !== playlistId) {
				position = typeof index === "number" ? index : 0;
			}
			if (currentMixId !== playlistId) mix = [];
			currentMixType = "playlist";
			try {
				playlistId = playlistId.startsWith("VL") ? playlistId.slice(2) : playlistId;
				const data = await fetchNext({
					params,
					playlistId: playlistId,
					clickTracking: clickTrackingParams,
					visitorData,
					playlistSetVideoId: playlistSetVideoId,
					videoId,
				});

				mix.push(...data.results);
				mix = filterList(mix);

				playerLoading.set(false);

				continuation = data?.continuation;
				clickTrackingParams = data?.clickTrackingParams;
				currentMixId = data?.currentMixId;

				commitChanges({ mix, clickTrackingParams, currentMixId, continuation, position: index, currentMixType });

				if (groupSession?.initialized && groupSession?.hasActiveSession) {
					groupSession.expAutoMix({ mix, clickTrackingParams, currentMixId, continuation, position, currentMixType });
				}
				return await getSrc(mix[index].videoId, playlistId);
			} catch (err) {
				console.error(err);

				playerLoading.set(false);
				notify("Error starting playback", "error");
				return null;
			}
		},
		async setMix(mix: Item[], type?: "auto" | "playlist" | "local") {
			const guard = await mutex.do(async () => {
				return new Promise<ISessionListProvider>((resolve) => {
					resolve(
						commitChanges({
							mix,
							clickTrackingParams,
							currentMixId,
							continuation,
							position,
							currentMixType: type ?? currentMixType,
						}),
					);
				});
			});
			if (groupSession?.initialized && groupSession?.hasActiveSession) {
				groupSession.send("PUT", "state.set.mix", JSON.stringify(guard), groupSession.client);
			}
		},
		getMoreLikeThis,
		async getSessionContinuation({ clickTrackingParams, ctoken, itct, key, playlistId, videoId }) {
			playerLoading.set(true);
			if (currentMixType === "playlist" && chunkedPlaylistMap.size && mix.length < chunkedListOriginalLen - 1) {
				chunkedPlaylistCurrentIdx++;

				const src = await getSrc(mix[mix.length - 1].videoId);

				mix.push(...Array.from(chunkedPlaylistMap.get(chunkedPlaylistCurrentIdx)!));
				mix = get(filterAutoPlay) ? [...filterList(mix)] : [...mix];

				playerLoading.set(false);

				commitChanges({ mix, clickTrackingParams, currentMixId, continuation, position, currentMixType });
				return await src.body;
			}

			if (!clickTrackingParams && !ctoken) {
				playlistId = "RDAMPL" + playlistId;
				itct = "wAEB8gECeAE%3D";
			}

			const data = await fetchNext({
				visitorData: visitorData,
				params: "OAHyAQIIAQ==",
				playlistSetVideoId: mix[position]?.playlistSetVideoId,
				index: mix.length,
				videoId,
				playlistId,
				ctoken,
				clickTracking: clickTrackingParams,
			}).then((res) => {
				if (res.results.length === 0) getMoreLikeThis({ playlistId });
				return res;
			});
			const results = data?.results as any[];
			mix.push(...results);

			mix = get(filterAutoPlay) ? filterList(mix) : mix;
			visitorData = data["visitorData"] ?? visitorData;

			continuation = data.continuation;
			currentMixId = data.currentMixId;
			clickTrackingParams = data.clickTrackingParams;

			commitChanges({ mix, clickTrackingParams, currentMixId, continuation, position, currentMixType });

			playerLoading.set(false);

			const src = await getSrc(mix[key].videoId);
			if (groupSession?.initialized && groupSession?.hasActiveSession) {
				groupSession.updateGuestContinuation({
					mix,
					clickTrackingParams,
					currentMixId,
					continuation,
					position,
					currentMixType,
				});
			}
			return src.body;
		},
		removeTrack(index: number) {
			mix.splice(index, 1);
			commitChanges({ mix, clickTrackingParams, currentMixId, continuation, position, currentMixType });
		},
		async setTrackWillPlayNext(item: Item, key) {
			if (!item) {
				notify("No track to remove was provided!", "error");
				return;
			}
			try {
				const itemToAdd = await addToQueue(item.videoId);

				// eslint-disable-next-line no-self-assign
				splice(mix, key + 1, 0, itemToAdd);

				commitChanges({ mix, clickTrackingParams, currentMixId, continuation, position, currentMixType });
			} catch (err) {
				console.error(err);
				notify(`Error: ${err}`, "error");
			}
		},

		shuffleRandom(items = []) {
			mix = [...items.sort(() => Math.random() - 0.6)];
			commitChanges({ mix, clickTrackingParams, currentMixId, continuation, position, currentMixType });

			if (groupSession?.initialized && groupSession?.hasActiveSession) {
				groupSession.updateGuestTrackQueue({
					mix,
					clickTrackingParams,
					currentMixId,
					continuation,
					position,
					currentMixType,
				});
			}
		},
		shuffle(index: number, preserveBeforeActive = true) {
			if (typeof index !== "number") return;
			if (!preserveBeforeActive) {
				mix = [...mix.sort(() => Math.random() - 0.5)];
			} else {
				mix = [...mix.slice(0, index), mix[index], ...mix.slice(index + 1).sort(() => Math.random() - 0.5)];
			}
			// console.log(mix)
			commitChanges({ mix, clickTrackingParams, currentMixId, continuation, position, currentMixType });

			if (groupSession?.initialized && groupSession?.hasActiveSession) {
				groupSession.updateGuestTrackQueue({
					mix,
					clickTrackingParams,
					currentMixId,
					continuation,
					position,
					currentMixType,
				});
			}
		},
		toJSON(): string {
			return JSON.stringify({ clickTrackingParams, continuation, currentMixId, mix, position, currentMixType });
		},
		get mix() {
			return mix;
		},
		get position() {
			return position;
		},
		get clickTrackingParams() {
			return clickTrackingParams ?? "";
		},
		get continuation() {
			return continuation;
		},
		get currentMixId() {
			return currentMixId;
		},
		updatePosition(direction: "next" | "back" | number): number {
			if (typeof direction === "number") {
				position = direction;

				commitChanges({ mix, clickTrackingParams, currentMixId, continuation, position, currentMixType });
				return position;
			}
			if (direction === "next") {
				position++;
			}
			if (direction === "back") {
				position--;
			}
			commitChanges({ mix, clickTrackingParams, currentMixId, continuation, position, currentMixType });

			return position;
		},
	};
}
export default SessionListService;
