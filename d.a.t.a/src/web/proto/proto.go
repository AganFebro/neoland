package proto

type TalkReq struct {
	Content string `json:"content" form:"content"`
}

type TalkRsp struct {
	Error
	Content string `json:"content"`
}

type HealthyRsp struct{}

type AreYouReadyRsp struct {
	Status string `json:"status"`
}
