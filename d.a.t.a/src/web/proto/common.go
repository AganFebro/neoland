package proto

type Error struct {
	ErrCode int64  `json:"err_code"`
	ErrMsg  string `json:"err_msg"`
}
