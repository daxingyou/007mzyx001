var roomMgr = require("./roommgr");
var userMgr = require("./usermgr"); 
var db = require("../utils/db");
var crypto = require("../utils/crypto");
var games = {};
var gamesIdBase = 0; 
var gameSeatsOfUsers = {};

var MAX_POKER_NUM = 52;

var ROOM_STATE_IDLE = "idle";
var ROOM_STATE_WAITING = "waiting";
var ROOM_STATE_BANKER = "banker";
var ROOM_STATE_DEALING = "dealing"; 
var ROOM_STATE_BET = "bet";
var ROOM_STATE_SETTLE = "settle"; 

//黑：1-13, 红：17-29, 棉：33-45, 方：49-61
//获取扑克类型
function getMJType(id){ 
    var type = id >> 4 
    return type 
}

//获取扑克值
function getMJValue(id){  
    var value = id & 0xc + 1
    return value 
}

//洗牌
function shuffle(game) { 
    var mahjongs = game.mahjongs; 
    var index = 0; 
    for (var t = 0; t < 4; t++) {  
        for(var i = 1; i <= 13; ++i){
            var v = t*16+i
            mahjongs[index] = v;
            index++;
        }   
    }
    
    for(var i = 0; i < mahjongs.length; ++i){
        var lastIndex = mahjongs.length - 1 - i;
        var index = Math.floor(Math.random() * lastIndex);
        var t = mahjongs[index];
        mahjongs[index] = mahjongs[lastIndex];
        mahjongs[lastIndex] = t;
    }
}

//发一张牌到玩家
function mopai(game,seatIndex) {
    if(game.currentIndex == game.mahjongs.length){
        return -1;
    }   
    var data = game.gameSeats[seatIndex];
    var mahjongs = data.holds;
    var pai = game.mahjongs[game.currentIndex];
    mahjongs.push(pai);
    game.currentIndex ++;
    return pai;
}

//发牌
function deal(game){
    //强制清0
    game.currentIndex = 0; 
    //每人2张
    var seatIndex = game.button;
    //总人数
    var count = game.gameSeats.length;
    //轮流发牌
    for(var i = 0; i < count*2; ++i){
        var mahjongs = game.gameSeats[seatIndex].holds;
        if(mahjongs == null){
            mahjongs = [];
            game.gameSeats[seatIndex].holds = mahjongs;
        }
        mopai(game,seatIndex);
        seatIndex ++;
        seatIndex %= count;
    }   
    //当前轮设置为庄家
    game.turn = game.button;
}

//设置庄家
function setbanker(game){ 
    var bankers = [];
    var seatIndex = game.button;
    var count = game.gameSeats.length; 
    for(var i = 0; i < count; ++i){
        var seat = game.gameSeats[seatIndex];
        if(seat.robBanker==1){
            bankers.push(seatIndex);
        }
        seatIndex ++;
        seatIndex %= count;
    }   
    
    var index = Math.floor(Math.random() * count);
    //当前轮设置为庄家
    game.button = index;
    game.turn = index;
}

//获取玩家位置
function getSeatIndex(userId){
    var seatIndex = roomMgr.getUserSeat(userId);
    if(seatIndex == null){
        return null;
    }
    return seatIndex;
}

//获取游戏管理
function getGameByUserID(userId){
    var roomId = roomMgr.getUserRoom(userId);
    if(roomId == null){
        return null;
    }
    var game = games[roomId];
    return game;
}

//移动到下一位
function moveToNextUser(game,nextSeat){ 
    //找到下一个没有和牌的玩家
    if(nextSeat == null){
        game.turn ++;
        game.turn %= game.gameSeats.length;
        return;
    }
    else{
        game.turn = nextSeat;
    }
}

//是否花色相同
function isSameType(type,arr){
    for(var i = 0; i < arr.length; ++i){
        var t = getMJType(arr[i]);
        if(type != -1 && type != t){
            return false;
        }
        type = t;
    }
    return true; 
}

//计算结算结果
function calculateResult(game,roomInfo){ 
    
    var iswin = function(holds1,holds2){ 
        
        var v1 = getMJValue(holds1[0]);
        var v2 = getMJValue(holds1[1]); 

        var v3 = getMJValue(holds2[0]);
        var v4 = getMJValue(holds2[1]); 
        
        var ret1 = 0;
        if(v1==v2){
            ret1 = (v1+32)
        }else{
            ret1 = (v1+v2) 
        }

        var ret2 = 0;
        if(v3==v4){
            ret2 = (v3+32)
        }else{
            ret2 = (v3+v4) 
        }

        if(ret1>ret2){
            return true;
        }else if(ret1<ret2){
            return false;
        }

        var max1 = Math.max(v1,v2);
        var max2 = Math.max(v3,v4);
        if(max1>max2){
            return true;
        }else if(max1<max2){
            return false;
        }
        
        var max3 = getMJType(Math.max(holds1[0],holds1[1]));
        var max4 = getMJType(Math.max(holds2[0],holds2[1]));

        if(max3>max4){
            return true; 
        }
        
        return false;
    }
    
    //庄家下注的总额度
    var button = game.button;
    var bd = game.gameSeats[button]; 
    bd.win = 0;

    for(var i = 0; i < game.gameSeats.length; ++i){
        if(i==button){
            continue;
        }   
        var sd = game.gameSeats[i];  
        sd.win = 0;
        var win = iswin(sd.holds,bd.holds);
        if(win==false){
            sd.score += sd.betscore; 
            bd.score -= sd.betscore;

            sd.win += sd.betscore;  
            bd.win -= sd.betscore;
        }else{ 
            sd.score -= sd.betscore;
            bd.score += sd.betscore; 

            sd.win -= sd.betscore; 
            bd.win += sd.betscore; 
        }   
    }   
}

//游戏结束
function doGameOver(game,userId,forceEnd){
    var roomId = roomMgr.getUserRoom(userId);
    if(roomId == null){
        return;
    }
    var roomInfo = roomMgr.getRoom(roomId);
    if(roomInfo == null){
        return;
    }
    
    var results = [];
    var dbresult = [];
    
    var fnNoticeResult = function(isEnd){
        var endinfo = null;
        if(isEnd){
            endinfo = [];
            for(var i = 0; i < roomInfo.seats.length; ++i){
                var rs = roomInfo.seats[i];
                endinfo.push({
                    userId:rs.userId,
                    score:rs.score,
                });
            }   
        }
        
        userMgr.broacastInRoom('game_over_push',{results:results,endinfo:endinfo},userId,true);
        //如果局数已够，则进行整体结算，并关闭房间
        if(isEnd){
            setTimeout(function(){
                if(roomInfo.numOfGames > 1){
                    store_history(roomInfo);    
                }
                userMgr.kickAllInRoom(roomId);
                roomMgr.destroy(roomId);
                db.archive_games(roomInfo.uuid);            
            },1500);
        }
    }

    if(game != null){
        if(!forceEnd){
            calculateResult(game,roomInfo);    
        }

        for(var i = 0; i < roomInfo.seats.length; ++i){
            var rs = roomInfo.seats[i];
            var sd = game.gameSeats[i];

            rs.ready = false;
            rs.score += sd.score 
            
            var userRT = {
                userId:sd.userId, 
                holds:sd.holds,
                score:sd.score,
                totalscore:rs.score,      
            }
            
            results.push(userRT);

            dbresult.push(sd.score);

            delete gameSeatsOfUsers[sd.userId];
        }
        delete games[roomId];
    }
    
    if(forceEnd || game == null){
        fnNoticeResult(true);   
    }
    else{
        //保存游戏
        store_game(game,function(ret){
            db.update_game_result(roomInfo.uuid,game.gameIndex,dbresult);
            
            //记录玩家操作
            var str = JSON.stringify(game.actionList);
            db.update_game_action_records(roomInfo.uuid,game.gameIndex,str); 
        
            //保存游戏局数
            db.update_num_of_turns(roomId,roomInfo.numOfGames);
            
            //如果是第一次，则扣除房卡
            if(roomInfo.numOfGames == 1){
                var cost = 2;
                if(roomInfo.conf.maxGames == 8){
                    cost = 3;
                }
                db.cost_gems(game.gameSeats[0].userId,cost);
            }
            
            var isEnd = (roomInfo.numOfGames >= roomInfo.conf.maxGames);
            fnNoticeResult(isEnd);
        });            
    }
}

//记录玩家操作
function recordUserAction(game,seatData,type,target){
    var d = {type:type,targets:[]};
    if(target != null){
        if(typeof(target) == 'number'){
            d.targets.push(target);    
        }
        else{
            d.targets = target;
        }
    }
    else{
        for(var i = 0; i < game.gameSeats.length; ++i){
            var s = game.gameSeats[i];
            //血流成河，所有自摸，暗杠，弯杠，都算三家
            if(i != seatData.seatIndex/* && s.hued == false*/){
                d.targets.push(i);
            }
        }        
    }

    seatData.actions.push(d);
    return d;
}

//记录游戏操作
function recordGameAction(game,si,action,pai){
    game.actionList.push(si);
    game.actionList.push(action);
    if(pai != null){
        game.actionList.push(pai);
    }
}

//保存单局记录
function store_single_history(userId,history){
    db.get_user_history(userId,function(data){
        if(data == null){
            data = [];
        }
        while(data.length >= 10){
            data.shift();
        }
        data.push(history);
        db.update_user_history(userId,data);
    });
}

//保存整局记录
function store_history(roomInfo){
    var seats = roomInfo.seats;
    var history = {
        uuid:roomInfo.uuid,
        id:roomInfo.id,
        time:roomInfo.createTime,
        seats:new Array(seats.length)
    };

    for(var i = 0; i < seats.length; ++i){
        var rs = seats[i];
        var hs = history.seats[i] = {};
        hs.userid = rs.userId;
        hs.name = crypto.toBase64(rs.name);
        hs.score = rs.score;
    }

    for(var i = 0; i < seats.length; ++i){
        var s = seats[i];
        store_single_history(s.userId,history);
    }
}

//基本信息
function construct_game_base_info(game){
    var baseInfo = {
        type:game.conf.type,
        button:game.button,
        index:game.gameIndex,
        mahjongs:game.mahjongs,
        game_seats:new Array(game.gameSeats.length)
    }
    for(var i = 0; i < game.gameSeats.length; ++i){
        baseInfo.game_seats[i] = game.gameSeats[i].holds;
    }   
    game.baseInfoJson = JSON.stringify(baseInfo);
}

function store_game(game,callback){
    db.create_game(game.roomInfo.uuid,game.gameIndex,game.baseInfoJson,callback);
}



//准备开始
exports.setReady = function(userId,callback){
    var roomId = roomMgr.getUserRoom(userId);
    if(roomId == null){
        return;
    }   
    var roomInfo = roomMgr.getRoom(roomId);
    if(roomInfo == null){
        return;
    }

    roomMgr.setReady(userId,true);

    var game = games[roomId];
    if(game == null){ 
        //游戏未开始，判断是否可以开始游戏
        if(roomInfo.seats.length > 2 ){
            for(var i = 0; i < roomInfo.seats.length; ++i){
                var s = roomInfo.seats[i];
                if(s.ready == false || userMgr.isOnline(s.userId)==false){
                    return;
                }
            }   
            //只要满足两个到齐了，并且都准备好了，则开始新的一局
            exports.begin(roomId);
        }
    }   
    else{
        //游戏继续，同步房间数据
        var numOfMJ = game.mahjongs.length - game.currentIndex;
        var remainingGames = roomInfo.conf.maxGames - roomInfo.numOfGames;

        var data = {
            state:game.state,   //状态
            numofmj:numOfMJ,    //剩余牌数
            button:game.button, //庄家
        };
        
        data.seats = [];        //位置信息
        var seatData = null;
        for(var i = 0; i < game.gameSeats.length; ++i){
            var sd = game.gameSeats[i]; 
            var s = {
                userid:sd.userId, 
                betscore:sd.betscore,
                state:sd.state,
                win:sd.win,
            }   
            if(sd.userId == userId){
                s.holds = sd.holds; 
                seatData = sd;
            }   
            else{ 
                s.holds = sd.holds;  
            }
            data.seats.push(s);
        }

        //同步整个信息给客户端
        userMgr.sendMsg(userId,'game_sync_push',data); 
    }
}

//开始新的一局
exports.begin = function(roomId) {
    var roomInfo = roomMgr.getRoom(roomId);
    if(roomInfo == null){
        return;
    }
    var seats = roomInfo.seats;

    var game = {
        conf:roomInfo.conf,//配置信息
        roomInfo:roomInfo,//房间信息
        gameIndex:roomInfo.numOfGames,//房间编号
        
        button:0,//庄家
        mahjongs:new Array(MAX_POKER_NUM),
        currentIndex:0,
        gameSeats:new Array(seats.length),
        
        state:ROOM_STATE_IDLE,
    };
    
    roomInfo.numOfGames++;

    for(var i = 0; i < game.gameSeats.length; ++i){
        var data = game.gameSeats[i] = {};

        data.game = game;

        data.seatIndex = i;

        data.userId = seats[i].userId;
        //持有的牌
        data.holds = [];
        //下注积分
        data.betscore = 0;
        //积分
        data.score = 0;
        //输赢
        data.win = 0;
        
        //是否可以下注
        data.canBetChip = false;
        
        gameSeatsOfUsers[data.userId] = data;
    }
    games[roomId] = game;
    //洗牌
    shuffle(game);
    //发牌
    //deal(game);
    
    var numOfMJ = game.mahjongs.length - game.currentIndex;
    
    for(var i = 0; i < seats.length; ++i){
        //开局时，通知前端必要的数据
        var s = seats[i];
        //通知玩家手牌
        userMgr.sendMsg(s.userId,'game_holds_push',game.gameSeats[i].holds);
        //通知还剩多少张牌
        userMgr.sendMsg(s.userId,'poker_count_push',numOfMJ);
        //通知还剩多少局
        userMgr.sendMsg(s.userId,'game_num_push',roomInfo.numOfGames);
        //通知游戏开始
        userMgr.sendMsg(s.userId,'game_begin_push',game.button);
        
        // 确定庄家状态
        game.state = "banker";
        // 通知抢庄
        userMgr.sendMsg(s.userId,'game_banker_push'); 
    }

};

//设置抢庄状态
exports.robBanker = function(userId,value,callback){
    var roomId = roomMgr.getUserRoom(userId);
    if(roomId == null){
        return;
    }   
    var roomInfo = roomMgr.getRoom(roomId);
    if(roomInfo == null){
        return;
    }

    var seatIndex = roomMgr.getUserSeat(userId);

	var s = roomInfo.seats[seatIndex];
    s.robBanker = value;
    
    var game = games[roomId];
    
    //同步整个信息给客户端
    var data = {
        userId:userId,
        state:value,
    }
    userMgr.sendMsg(userId,'robbanker_sync_push',data); 
    
    //游戏未开始，判断是否可以开始游戏 
    for(var i = 0; i < roomInfo.seats.length; ++i){
        var s = roomInfo.seats[i];
        if(s.robBanker == 0 ){
            return;
        }
    }   

    //确定庄家
    setbanker(game);

    //开始发牌
    deal(game); 
}

//下注
exports.betChip = function(userId,chips){

    chips = Number.parseInt(chips);
    var seatData = gameSeatsOfUsers[userId];
    if(seatData == null){
        console.log("can't find user game data.");
        return;
    }

    var game = seatData.game;
    var seatIndex = seatData.seatIndex;
    //如果不该他出，则忽略
    if(game.turn != seatData.seatIndex){
        console.log("not your turn.");
        return;
    }

    if(seatData.canBetChip == false){
        console.log('no need chupai.');
        return;
    }
    
    //添加下注数量
    seatData.betscore += chips;
    
    userMgr.broacastInRoom('game_bet_notify_push',{userId:seatData.userId,betscore:chips},seatData.userId,true);
    
};

exports.isPlaying = function(userId){
    var seatData = gameSeatsOfUsers[userId];
    if(seatData == null){
        return false;
    }

    var game = seatData.game;

    if(game.state == "idle"){
        return false;
    }
    return true;
}

//结算
exports.settle = function(){

};

exports.hasBegan = function(roomId){
    var game = games[roomId];
    if(game != null){
        return true;
    }
    var roomInfo = roomMgr.getRoom(roomId);
    if(roomInfo != null){
        return roomInfo.numOfGames > 0;
    }
    return false;
};


var dissolvingList = [];

exports.doDissolve = function(roomId){
    var roomInfo = roomMgr.getRoom(roomId);
    if(roomInfo == null){
        return null;
    } 
    var game = games[roomId];
    doGameOver(game,roomInfo.seats[0].userId,true);
};

exports.dissolveRequest = function(roomId,userId){
    var roomInfo = roomMgr.getRoom(roomId);
    if(roomInfo == null){
        return null;
    }

    if(roomInfo.dr != null){
        return null;
    }

    var seatIndex = roomMgr.getUserSeat(userId);
    if(seatIndex == null){
        return null;
    }

    roomInfo.dr = {
        endTime:Date.now() + 30000,
        states:[false,false,false,false]
    };
    roomInfo.dr.states[seatIndex] = true;

    dissolvingList.push(roomId);

    return roomInfo;
};

exports.dissolveAgree = function(roomId,userId,agree){
    var roomInfo = roomMgr.getRoom(roomId);
    if(roomInfo == null){
        return null;
    }

    if(roomInfo.dr == null){
        return null;
    }

    var seatIndex = roomMgr.getUserSeat(userId);
    if(seatIndex == null){
        return null;
    }

    if(agree){
        roomInfo.dr.states[seatIndex] = true;
    }
    else{
        roomInfo.dr = null;
        var idx = dissolvingList.indexOf(roomId);
        if(idx != -1){
            dissolvingList.splice(idx,1);           
        }
    }
    return roomInfo;
};

function update() {
    for(var i = dissolvingList.length - 1; i >= 0; --i){
        var roomId = dissolvingList[i];
        
        var roomInfo = roomMgr.getRoom(roomId);
        if(roomInfo != null && roomInfo.dr != null){
            if(Date.now() > roomInfo.dr.endTime){
                console.log("delete room and games");
                exports.doDissolve(roomId);
                dissolvingList.splice(i,1); 
            }
        }
        else{
            dissolvingList.splice(i,1);
        }
    }
}

exports.update = update

//setInterval(update,1000);