package clients

import (
    "context"
    "strings"

    "github.com/bwmarrin/discordgo"
)

type DiscordMsg struct {
    AuthorID  string
    Content   string
    ChannelID string
    Attachments []Attachment
}

type Attachment struct {
    URL         string
    Filename    string
    ContentType string
    Size        int
}

type DiscordBot struct {
	session    *discordgo.Session
	msgChannel chan DiscordMsg
}

func NewDiscordBot(token string) *DiscordBot {
	discord, err := discordgo.New("Bot " + token)
	if err != nil {
		// TODO: handle error
		panic(err)
	}

	msgChannel := make(chan DiscordMsg)
	discord.AddHandler(MessageListener(msgChannel))
	discord.Open()

	return &DiscordBot{
		session:    discord,
		msgChannel: msgChannel,
	}
}

func (dc *DiscordBot) GetMessageChannel() <-chan DiscordMsg {
	return dc.msgChannel
}

func (dc *DiscordBot) SendMessage(
	ctx context.Context,
	msg *DiscordMsg,
) error {
	_, err := dc.session.ChannelMessageSend(msg.ChannelID, msg.Content)
	return err
}

func MessageListener(
	msgChannel chan<- DiscordMsg,
) func(*discordgo.Session, *discordgo.MessageCreate) {
	return func(discord *discordgo.Session, message *discordgo.MessageCreate) {
		channel, err := discord.Channel(message.ChannelID)
		if err != nil {
			return
		}

        if shouldReact(discord.State.User, channel, message) {
            // collect basic attachment info
            var atts []Attachment
            for _, a := range message.Attachments {
                atts = append(atts, Attachment{
                    URL:         a.URL,
                    Filename:    a.Filename,
                    ContentType: a.ContentType,
                    Size:        a.Size,
                })
            }
            msgChannel <- DiscordMsg{
                AuthorID:   message.Author.ID,
                Content:    message.Content,
                ChannelID:  message.ChannelID,
                Attachments: atts,
            }
        }
    }
}

func shouldReact(
    me *discordgo.User,
    channel *discordgo.Channel,
    message *discordgo.MessageCreate,
) bool {
	/* prevent bot responding to its own message
	this is achived by looking into the message author id
	if message.author.id is same as bot.author.id then just return
	*/
	if message.Author.ID == me.ID {
		return false
	}

	/* always respond to direct messages */
	if channel.Type == discordgo.ChannelTypeDM {
		return true
	}

    /* check if bot was mentioned in the message */
    for _, mention := range message.Mentions {
        if mention.ID == me.ID {
            return true
        }
    }

    // Also react to public messages that clearly ask for deploy without a mention
    content := strings.ToLower(message.Content)
    if strings.Contains(content, "deploy") && strings.Contains(content, "nft") {
        return true
    }

    return false
}
