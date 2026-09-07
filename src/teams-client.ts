// Internal compatibility entrypoint. Resource implementations live under teams/.
export type { Participant, ChatSummary, ChannelSummary, PersonSummary, PersonSearchResult, PersonPhone, PersonProfile, PersonResult, DirectMessageTarget, PersonImage, PersonImageSize, MessageSummary, PageInfo, ChatPage, ChatSearchResult, ChannelList, ChatResult, ChannelResult, MessagePage, MessageResult, MessageSendResult, MessagePageOptions } from "./teams/types.js";
export { TeamsApiError } from "./teams/transport.js";
export { searchPeople, getPerson, getPersonImage } from "./teams/people.js";
export { listChats, searchChats, getChat, resolveDirectMessageTarget } from "./teams/chats.js";
export { listChannels, getChannel } from "./teams/channels.js";
export { listMessages, getMessage, sendMessage } from "./teams/messages.js";
