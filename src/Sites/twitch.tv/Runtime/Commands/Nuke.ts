import { Twitch } from 'src/Sites/twitch.tv/Util/Twitch';
import { BaseCommand } from 'src/Sites/twitch.tv/Runtime/Commands/BaseCommand';
import { TwitchPageScript } from 'src/Sites/twitch.tv/twitch';

/**
 *  ToDo list:
 *      Update help text.
 *      Log messages better and remove them after a certain time.
 * 		Currently it stores all messages until a reload which is not optimal.
 */

export class Nuke extends BaseCommand {

	private messageLog =  new Set<Twitch.ChatMessage>();
	private bucket = new RateBucket(100);
	private lastNuke: string | undefined = undefined;
	private executed = new Set<string>();

	constructor (main: TwitchPageScript) {
		super(main);
		this.add();
	}

	add() {
		super.add(this.command);
		this.twitch.getChatController().props.messageHandlerAPI.addMessageHandler(this.messageHandler);
	}

	remove() {
		super.remove(this.command);
		if (this.lastNuke) super.remove(this.undoCommand);
		this.twitch.getChatController().props.messageHandlerAPI.removeMessageHandler(this.messageHandler);
	}

	private messageHandler = (msg: Twitch.ChatMessage) => {
		if (msg.type == 0) this.messageLog.add(msg);
	}

	async execute(args: NukeArgs): Promise<string> {
		const start = Date.now() - (args.before * 1000);
		const controller = this.twitch.getChatController();
		this.executed.clear();

		const msgBuilder = (msg: Twitch.ChatMessage) => {
			switch(args.action) {
				case 'ban':
					return `.ban ${msg.user.userLogin} ${args.reason}`;
				case 'delete':
					return `.delete ${msg.id}`;
				default:
					return `.timeout ${msg.user.userLogin} ${args.action} ${args.reason}`;
			}
		};

		const myID = controller.props.userID;
		let ammount = 0;

		const check = (msg: Twitch.ChatMessage) => {
			if (msg.type !== 0 || msg.user.userID == myID || msg.user.userType == 'mod') return;
			if (args.action != 'delete' && this.executed.has(msg.user.userLogin)) return;

			if (args.pattern.test(msg.messageBody)) {
				if (this.bucket.take()){
					controller.sendMessage(msgBuilder(msg), undefined);
					this.executed.add(msg.user.userLogin);
					ammount += 1;
				}
			}
		};

		for (const msg of Array.from(this.messageLog).reverse()){
			if (msg.timestamp < start) break;
			check(msg);
		}

		if (args.after) {
			const handler = (msg: Twitch.ChatMessage) => {
				if (msg.type === 0) check(msg);
			};

			controller.props.messageHandlerAPI.addMessageHandler(handler);

			setTimeout(() => {
				controller.props.messageHandlerAPI.removeMessageHandler(handler);
			}, args.after * 1000);
		}

		super.remove(this.undoCommand);
		this.lastNuke = args.pattern.toString();

		if (args.action !== 'delete') super.add(this.undoCommand);

		switch(args.action) {
			case 'delete':
				return `Deleted ${ammount} messages containing ${args.pattern}`;
			case 'ban':
				return `Banned ${ammount} users matching ${args.pattern} . Undo with /undo`;
			default:
				return `Timed out ${ammount} users matching ${args.pattern} for ${args.action} . Undo with /undo` ;
		}

	}

	handler: Twitch.ChatCommand.Handler = (args: string) => {
		let parsed: NukeArgs;
		try {
			let matches = args.match(re.nukeArgs)?.groups;

			if (!matches) throw new Error;
			if (!matches.pattern) throw errors.nuke.pattern;
			if (!matches.action) throw errors.nuke.action;
			if (!matches.before) throw errors.nuke.timebounds;

			const convert = (s:string)=>{return ({d:60*60*24, h:60*60, m: 60, s:1} as any)[s.slice(-1)]*parseInt(s.slice(0, -1));};
			const asRegex = matches.pattern.match(re.isRegex);

			parsed = {
				pattern: asRegex ? new RegExp(asRegex[1], asRegex[2]) : new RegExp(matches.pattern),
				action: matches.action,
				before: convert(matches.before),
				after: matches.after ? convert(matches.after) : undefined,
				reason: matches.reason ? matches.reason : 'Nuked!'
			};

		} catch (err: any) {
			return {
				deferred: Promise.resolve({
					notice: err.message || this.command.helpText,
					error: 'Invalid arguments'
			})};
		}

		return {
			deferred: this.execute(parsed)
				.then((message: string) => {
					return {
						notice: message
					};
				})
		};
	}

	command: Twitch.ChatCommand = {
		name: 'nuke',
		description: '⚠️ Nuke a pattern in the chat! - /help nuke',
		helpText: 'Usage: "/nuke <pattern> <action> <timebounds past:(future)> . "/nuke something bad 10m 3m" would give a 10 minute timeout to anything containing the phrase "something bad" going back 3 minutes in the past. "/nuke /i ?hate ?(red)|(blue)|(green)/i ban 5m:5m" would ban everything that matches the regex going back 5 minutes and keep banning for 5 minutes. Actions are: delete, ban or duration in d, m, h or s. For regex see regex101.com. Using this wrong can cause huge accidents but can also be a very powerfull tool.',
		permissionLevel: 2,
		handler: this.handler,
		commandArgs: [
			{
				name: 'pattern',
				isRequired: true
			},
			{
				name: 'action',
				isRequired: true
			},
			{
				name: 'past:future',
				isRequired: true
			}
		],
		group: '7TV'
	};

	undoCommand: Twitch.ChatCommand = {
		name: 'undo',
		description: `Undo the last nuke`,
		helpText: 'Usage: "/undo undo\'s the last nuke. If the last nuke was close to 100 to twitch\'s rate limit might be a hinderance, and you should wait 30 seconds.',
		permissionLevel: 2,
		handler: () => {
			const controller = this.twitch.getChatController();
			const ammount = this.executed.size;
			this.executed.forEach(userLogin => controller?.sendMessage(`.unban ${userLogin}`, undefined));
			this.executed.clear();

			this.lastNuke = undefined;
			return {
				deferred: Promise.resolve({
					notice: `Removed timeout/ban on ${ammount} users.`
			})};
		},
		group: '7TV'
	};
}

namespace re {
	export const isRegex = new RegExp('\/(?<pattern>.+)\/(?<params>[gimyused]*)');
	export const nukeArgs = new RegExp('^(?<pattern>.+) (?<action>(delete|ban|[0-9]+[dhms])) (?<before>[0-9]+[dhmsDHMS])(:(?<after>([0-9]+[dhms])))?( (?<reason>.+))?$', 'i');
}

interface NukeArgs {
	pattern: RegExp;
	action: string;
	before: number;
	after?: number;
	reason: string;
}

namespace errors {
	export namespace nuke {
		export const pattern = 'Invalid pattern. Usage <pattern/regex> either text that will be searched for or a regex pattern in the form /pattern/ .';
		export const timebounds = 'Invalid timebounds. Usage: <past:future> -> 10m:5m or 10m if no percistence into the future. An integer, followed by d for day, h for hour, m for minute, s for second.';
		export const action = 'Invalid action. Usage: <action> is either ban, delete or timeout in the format 10s or 5m etc.';
	}
}

class RateBucket {
	tokens: number;
	constructor(private capacity: number) {
		this.tokens = capacity;
		setInterval(() => this.addToken(),  30000 / capacity );
	}

	addToken() {
		if (this.tokens < this.capacity) {
			this.tokens += 1;
		}
	}

	take() {
		if (this.tokens > 0) {
			this.tokens -= 1;
			return true;
		}

		return false;
	}
}
