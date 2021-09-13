import React from 'react';
import ReactDOM from 'react-dom';
import { asapScheduler, from, iif, Observable, of, scheduled, throwError } from 'rxjs';
import { catchError, map, mergeAll, switchMap, tap, toArray } from 'rxjs/operators';
import { API } from 'src/Global/API';
import { Badge } from 'src/Global/Badge';
import { PageScriptListener } from 'src/Global/Decorators';
import { EmoteStore } from 'src/Global/EmoteStore';
import { SettingValue } from 'src/Global/Util';
import { Logger } from 'src/Logger';
import { EmbeddedUI } from 'src/Sites/app/EmbeddedUI';
import { MainComponent } from 'src/Sites/app/MainComponent';
import { TabCompleteDetection } from 'src/Sites/app/Runtime/TabCompleteDetection';

export class SiteApp {
	api = new API();
	mainComponent: MainComponent | null = null;
	emoteStore = new EmoteStore();
	embeddedUI = new EmbeddedUI(this);
	badges = [] as Badge[];
	badgeMap = new Map<number, number[]>();
	currentChannel = '';
	tabCompleteDetector = new TabCompleteDetection(this);
	config = config;

	constructor() {
		// Once the extension injected itself into Twitch
		const app = document.createElement('div');
		app.classList.add('seventv-overlay');
		app.style.position = 'absolute';
		app.id = 'seventv';

		const target = document.getElementById('root');
		target?.firstChild?.appendChild(app);

		this.mainComponent = ReactDOM.render(<MainComponent emoteStore={this.emoteStore} />, app) as unknown as MainComponent;
		this.mainComponent.app = this;

		// Fetch Badges
		this.api.GetBadges().pipe(
			switchMap(badges => from(badges)),
			map((badge, i) => {
				this.badges[i] = badge;
				for (const u of badge.users) {
					let id: number | string = parseInt(u);
					if (isNaN(id)) {
						id = u;
					}

					if (this.badgeMap.has(id as number)) {
						this.badgeMap.set(id as number, [...this.badgeMap.get(id as number) as number[], i]);
					} else {
						this.badgeMap.set(id as number, [i]);
					}
				}
				return badge;
			}),
			toArray(),
			tap(badges => Logger.Get().info(`Loaded ${badges.length} badges`))
		).subscribe();
	}

	switchChannel(data: {
		channelID: string;
		channelName: string;
		as: string;
	}): Observable<EmoteStore.EmoteSet> {
		this.emoteStore.disableSet(this.currentChannel);
		this.emoteStore.disableSet(data.as);
		this.mainComponent?.toggleEmoteMenu(undefined, false);

		// Remove current channel from event subscriptions
		if (this.currentChannel?.length > 0) {
			this.api.events.removeChannel(this.currentChannel);
		}

		const afterLoaded = () => {
			this.tabCompleteDetector.updateEmotes();
			this.tabCompleteDetector.start();
			this.api.events.addChannel(this.currentChannel);
		};

		const emoteGetter = [
			this.api.GetChannelEmotes(data.channelID).pipe(catchError(_ => of([]))),
			this.api.GetGlobalEmotes().pipe(catchError(_ => of([]))),
			this.api.GetFrankerFaceZChannelEmotes(data.channelID).pipe(
				catchError(err => of([]).pipe(
					tap(() => console.error(err))
				))
			),
			this.api.GetFrankerFaceZGlobalEmotes().pipe(
				catchError(err => of([]).pipe(
					tap(() => console.error(err))
				))
			),
			this.api.GetBTTVChannelEmotes(data.channelID).pipe(
				catchError(err => of([]).pipe(
					tap(() => console.error('BTTV Channel Emotes Error', err))
				))
			),
			this.api.GetBTTVGlobalEmotes().pipe(
				catchError(err => of([]).pipe(
					tap(() => console.error(err))
				))
			)
		];

		return scheduled(emoteGetter, asapScheduler).pipe(
			mergeAll(),
			toArray(),
			map(a => a.reduce((a, b) => a.concat(b as any))),
			switchMap(e => iif(() => e.length === 0,
				throwError(Error(`7TV failed to load (perhaps service is down?)`)),
				of(e)
			)),
			map(e => this.emoteStore.enableSet(data.channelID, e)),
			tap(() => {
				this.embeddedUI.embedChatButton();
				this.currentChannel = data.channelID;
				afterLoaded();
			})
		);
	}

	@PageScriptListener('OnAssets')
	onExtensionAssets(assetMap: [string, string][]) {
		assetStore = new Map(assetMap);
	}

	@PageScriptListener('ConfigChange')
	whenAppConfigChangeds(cfg: { [x: string]: any; }): void {
		for (const k of Object.keys(cfg)) {
			config.set(k, new SettingValue(cfg[k]));
		}
	}
}

export let assetStore = new Map<string, string>();
const config = new Map<string, SettingValue>();