import { EmoteStore } from 'src/Global/EmoteStore';
import { Logger } from 'src/Logger';
import { BaseCommand } from 'src/Sites/twitch.tv/Runtime/Commands/BaseCommand';
import { TwitchPageScript } from 'src/Sites/twitch.tv/twitch';
import { Twitch } from 'src/Sites/twitch.tv/Util/Twitch';
import { assetStore } from 'src/Sites/app/SiteApp';

import React, { } from 'react';

/**
 *  ToDo list:
 * 		Need to implement a way to get the jwt token before this can be used.
 *      Need better help/error messages
 */

export class Dashboard extends BaseCommand {

	private jwt = this.main.site.config.get('jwt')?.asString();

	private currentChannelID: string | undefined;

	constructor(main: TwitchPageScript){
		super(main);
		if (!this.jwt) return;
		this.jwt = 'Bearer ' + this.jwt;
		this.setCurrentChannelId()
			.then(() => {
				return this.hasPermission();
			})
			.then(permission=>{
				if (permission) {
					super.add(this.commandEnable);
					super.add(this.commandDisable);
					super.add(this.commandAlias);
				}
			})
			.catch(()=>{
				Logger.Get().warn('Error with determining if you have permission, channel might not have 7tv enabled');
			});
	}

	async hasPermission() {
		const info = this.twitch.getChatController().props;

		if (info.channelID == info.userID) return true;

		const res = await this.sendRequest(querys.editors, {id: this.currentChannelID});
		if (!res.ok) throw new Error;

		const json = await res.json();
		const editor_ids: string[] = json?.data?.user?.editor_ids;

		// This could probably be stored since its bound to the jwt
		const res2 = await fetch('https://api.7tv.app/v2/users/' + info.userID);
		if (!res2.ok) throw new Error;

		const json2 = await res2.json();
		const myID = json2.id;

		if (editor_ids.includes(myID)) return true;

		return false;
	}

	async setCurrentChannelId() {
		await fetch('https://api.7tv.app/v2/users/' + this.main.currentChannel)
			.then(response => {
				if (!response.ok) throw new Error;
				return response.json();
			})
			.then(json => {
				if (!json.id) throw new Error;
				this.currentChannelID = json.id;
			})
			.catch(() => {
				throw new Error;
			});

		return;
	}

	async handleRequest(query: string, variables: any) {
		const res = await this.sendRequest(query, variables);

		if (!res.ok) {
			const json = await res.json();
			if (json.errors.message) {
				return {
					notice: 'Unable to do request: Error message: ' + json.errors.message,
					error: 'Api error'
				};
			}
			return {
				notice: 'Unable to do request. Error code: ' + res.status,
				error: 'Api error'
			};
		}

		return {
			notice: ''
		};
	}

	async sendRequest(query: string, variables: any) {
		return fetch('https://api.7tv.app/v2/gql',
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': this.jwt!
				},
				body: JSON.stringify({
					query: query,
					variables: variables
				})
			}
		);
	}

	async queryEmotes(name: string) {
		const res = await this.sendRequest(querys.search, {
				// \b to always search for start of word
				query: '\\b' + name,
				page: 1,
				pageSize: 16,
				limit: 16,
				sortBy: 'popularity',
				sortOrder: 0,
			}
		);

		if (!res.ok) return undefined;

		const json = await res.json();

		return json.data.search_emotes;
	}

	async handleEnable(args: string) {
		const [name, ...reason] = args.split(' ').filter(n=>n);

		const emotes = await this.queryEmotes(name);

		if (!emotes) {
			return {
				notice: 'Could not find any emotes named: ' + name,
				error: 'Input error'
			};
		}

		const store = new EmoteStore.EmoteSet('search');
		store.push(emotes);

		const tray = this.twitch.searchUp(Twitch.Selectors.ChatInput, n=>n.stateNode.props.setModifierTray, 100);

		return await new Promise<{notice: string, error?: string}>(resolve => {
			const onClick = (e: any, id: string) => {
				e.stopPropagation();

				if (e.ctrlKey) {
					window.open('https://7tv.app/emotes/' + id, '_blank');
					return;
				}

				this.handleRequest(querys.enable, {
					ch: this.currentChannelID!,
					em: id,
					re: reason.join(' ') ?? 'Edited from twitch chat'
				})
				.then(res => {
						tray.props.clearModifierTray();
						resolve(res);
				});
			};

			tray.props.setModifierTray({
				body:
					<div className='seventv-tray'>
						<div className='header'>
							<span className='logo'>
								<img src={assetStore.get('7tv.webp')}/>
							</span>
							<span className='text'>
								<text>
									Click to enable.
								</text>
							</span>
							<span className='close' onClick={() => {
									tray.props.clearModifierTray();
									resolve({notice: ''});
								}}>
								<text>
									&#10006;
								</text>
							</span>
						</div>
						<div className='body'>
							{store.getEmotes().map( emote => (
								<span title={`${emote.name} by ${emote.owner?.display_name}`} key={emote.id} onClick={e=>onClick(e, emote.id)}>
									<img src={emote.cdn('2')}/>
								</span>
							))}
						</div>
					</div>,
				floating: true,
			});

		}).catch(() => {
			return {
				notice: 'Could not enable emote',
				error: 'Api error'
			};
		});
	}

	async handleDisable(args: string) {
		const [emoteName, ...reason] = args.split(' ').filter(n=>n);

		const emote = this.main.emoteStore.getEmote(emoteName);

		if (emote?.provider != '7TV' ) {
			return {
				notice: 'Could not find selected 7TV emote',
				error: 'Missing emote'
			};
		}

		const variables = {
			ch: this.currentChannelID!,
			em: emote.id,
			re: reason.join(' ') ?? 'Edited from twitch chat'
		};

		return this.handleRequest(querys.disable, variables);
	}

	async handleAlias(args: string) {
		const [currentName, newName, ...reason] = args.split(' ').filter(n=>n);

		const emote = this.main.emoteStore.getEmote(currentName);

		if (emote?.provider != '7TV' ) {
			return {
				notice: 'Could not find selected 7TV emote.',
				error: 'Missing emote'
			};
		}

		if (!emoteNameRegex.test(newName)) {
			if (newName !== '-') {
				return {
					notice: 'Illegal characters in new alias',
					error: 'Argument error'
				};
			}
		}

		const variables = {
			ch: this.currentChannelID!,
			em: emote.id,
			data: {
				alias: (newName === '-') ? '' : newName
			},
			re: reason.join(' ') ?? 'Edited from twitch chat'
		};

		return this.handleRequest(querys.alias, variables);
	}

	commandEnable: Twitch.ChatCommand = {
		name: 'enable',
		description: 'Enable a 7TV emote',
		helpText: '',
		permissionLevel: 0,
		handler: (args) => { return { deferred: this.handleEnable(args) }; },
		commandArgs: [
			{
				name: 'emote',
				isRequired: true
			},
			{
				name: 'reason',
				isRequired: false
			}
		],
		group: '7TV'
	};

	commandDisable: Twitch.ChatCommand = {
		name: 'disable',
		description: 'Disable a 7TV emote',
		helpText: '',
		permissionLevel: 0,
		handler: (args) => { return { deferred: this.handleDisable(args) }; },
		commandArgs: [
			{
				name: 'emote',
				isRequired: true
			},
			{
				name: 'reason',
				isRequired: false
			}
		],
		group: '7TV'
	};

	commandAlias: Twitch.ChatCommand = {
		name: 'alias',
		description: 'Set an alias for a 7TV emote',
		helpText: '',
		permissionLevel: 0,
		handler: (args) => { return { deferred: this.handleAlias(args) }; },
		commandArgs: [
			{
				name: 'current',
				isRequired: true
			},
			{
				name: 'new',
				isRequired: true
			},
			{
				name: 'reason',
				isRequired: false
			}
		],
		group: '7TV'
	};
}

const emoteNameRegex = new RegExp(`^[-_A-Za-z():0-9]{2,100}$`);



const querys = {
	enable: `
		mutation AddChannelEmote($ch: String!, $em: String!, $re: String!) {
			addChannelEmote(channel_id: $ch, emote_id: $em, reason: $re) {
				emote_ids
			}
		}
	`,
	disable: `
		mutation RemoveChannelEmote($ch: String!, $em: String!, $re: String!) {
			removeChannelEmote(channel_id: $ch, emote_id: $em, reason: $re) {
				emote_ids
			}
		}
	`,
	alias: `
		mutation EditChannelEmote($ch: String!, $em: String!, $data: ChannelEmoteInput!, $re: String) {
			editChannelEmote(channel_id: $ch, emote_id: $em, data: $data, reason: $re) {
				id
			}
		}
	`,
	editors: `
		query GetUser($id: String!) {
			user(id: $id) {
				editor_ids
			}
		}
	`,
	search: `
		query($query: String!,$page: Int,$pageSize: Int,$globalState: String,$sortBy: String,$sortOrder: Int,$channel: String,$submitted_by: String,$filter: EmoteFilter) {
			search_emotes(query: $query,limit: $pageSize,page: $page,pageSize: $pageSize,globalState: $globalState,sortBy: $sortBy,sortOrder: $sortOrder,channel: $channel,submitted_by: $submitted_by,filter: $filter) {
				id,
				name,
				owner {
					id,
					twitch_id,
					login,
					display_name,
					role {
						id,
						name,
						position,
						color,
						allowed,
						denied
					}
				},
				visibility,
				mime,
				status,
				tags,
				width,
				height,
				urls,
				provider
			}
		}

	`
};
