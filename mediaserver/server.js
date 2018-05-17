
const http = require('http')
const MediaServer  = require("medooze-media-server");
const EventEmitter	= require('events').EventEmitter;
const TransactionManager = require("transaction-manager");
//Get Semantic SDP objects
const SemanticSDP	= require('semantic-sdp');
const SDPInfo		= SemanticSDP.SDPInfo;
const MediaInfo		= SemanticSDP.MediaInfo;
const CandidateInfo	= SemanticSDP.CandidateInfo;
const DTLSInfo		= SemanticSDP.DTLSInfo;
const ICEInfo		= SemanticSDP.ICEInfo;
const StreamInfo	= SemanticSDP.StreamInfo;
const TrackInfo		= SemanticSDP.TrackInfo;
const Direction		= SemanticSDP.Direction;
const CodecInfo		= SemanticSDP.CodecInfo;



const express = require('express');
const WebSocket = require('ws');


class Participant
{
	constructor(id,name,room)
	{
		//Store props
		this.id = id;
		this.name = name;
		
		//And casting
		this.room = room;
		
		//Create event emitter
		this.emitter = new EventEmitter();
		
		//Streams
		this.incomingStreams = new Map();
		this.outgoingStreams = new Map();
		
		//SDP info
		this.localSDP = null;
		this.remoteSDP = null;
		
		//Create uri
		this.uri = room.uri.concat(["participants",id]);
		
		this.debug = function(str) {
			room.debug("participant["+id+"]::"+str)
		};
	}
	
	getId() 
	{
		return this.id;
	}
	
	init(sdp) {
		this.debug("init");
		//Get data
		const endpoint  = this.room.getEndpoint();
		
		//Create an DTLS ICE transport in that enpoint
		this.transport = endpoint.createTransport({
			dtls : sdp.getDTLS(),
			ice  : sdp.getICE() 
		});
		
		//Dump contents
		//this.transport.dump("/tmp/sfu-"+this.uri.join("-")+".pcap");

		//Set RTP remote properties
		this.transport.setRemoteProperties({
			audio : sdp.getMedia("audio"),
			video : sdp.getMedia("video")
		});

		//Create local SDP info
		const answer = sdp.answer({
			dtls		: this.transport.getLocalDTLSInfo(),
			ice		: this.transport.getLocalICEInfo(),
			candidates	: endpoint.getLocalCandidates(),
			capabilities	: this.room.getCapabilities()
		});
		
		//Set RTP local  properties
		this.transport.setLocalProperties({
			audio : answer.getMedia("audio"),
			video : answer.getMedia("video")
		});
		
		//All good
		this.localSDP = answer;
		this.remoteSDP = sdp;
	}
		
	publishStream(streamInfo)
	{
		this.debug("publishStream()");
		
		//If already publishing
		if (!this.transport)
			throw Error("Not inited");

		//Create the remote participant stream into the transport
		const incomingStream = this.transport.createIncomingStream(streamInfo);
		
		//Add origin
		incomingStream.uri = this.uri.concat(["incomingStreams",incomingStream.getId()]);

		//Append
		this.incomingStreams.set(incomingStream.id,incomingStream);

		//Publish stream
		this.debug("onstream");
		this.emitter.emit("stream",incomingStream);
	}
	
	addStream(stream) {
		
		this.debug("addStream() "+stream.uri.join("/"));
		
		//Create sfu local stream
		const outgoingStream = this.transport.createOutgoingStream({
			audio: true,
			video: true
		});
		
		//Add uri
		outgoingStream.uri = this.uri.concat(["outgoingStreams",outgoingStream.getId()]);
		
		//Get local stream info
		const info = outgoingStream.getStreamInfo();
		
		//Add to local SDP
		this.localSDP.addStream(outgoingStream.getStreamInfo());
		
		//Append
		this.outgoingStreams.set(outgoingStream.getId(),outgoingStream);
			
		//Emit event
		this.debug("onrenegotiationneeded");
		this.emitter.emit("renegotiationneeded", this.localSDP);
		
		//Attach
		outgoingStream.attachTo(stream);
		
		//Listen when this stream is removed & stopped
		stream.on("stopped",()=>{
			//If we are already stopped
			if (!this.outgoingStreams)
				//Do nothing
				return;
			//Remove stream from outgoing streams
			this.outgoingStreams.delete(outgoingStream.getId());
			//Remove from sdp
			this.localSDP.removeStream(info);
			//Emit event
			this.debug("onrenegotiationneeded");
			this.emitter.emit("renegotiationneeded", this.localSDP);
			
			//Remove stream
			outgoingStream.stop();
		});
	}
	
		
	getInfo() {
		//Create info 
		const info = {
			id	: this.id,
			name	: this.name,
			streams : [
				this.incomingStream ? this.incomingStream.getId() : undefined
			]
		};
		
		//Return it
		return info;
	}
	
	getLocalSDP() {
		return this.localSDP;
	}
	
	getRemoteSDO() {
		return this.remoteSDP;
	}
	
	getIncomingStreams() {
		return this.incomingStreams.values();
	}
	
	/**
	 * Add event listener
	 * @param {String} event	- Event name 
	 * @param {function} listeener	- Event listener
	 * @returns {Transport} 
	 */
	on() 
	{
		//Delegate event listeners to event emitter
		this.emitter.on.apply(this.emitter, arguments);  
		//Return object so it can be chained
		return this;
	}
	
	/**
	 * Remove event listener
	 * @param {String} event	- Event name 
	 * @param {function} listener	- Event listener
	 * @returns {Transport} 
	 */
	off() 
	{
		//Delegate event listeners to event emitter
		this.emitter.removeListener.apply(this.emitter, arguments);
		//Return object so it can be chained
		return this;
	}
	
	stop() 
	{
		this.debug("stop");
		
		//remove all published streams
		for (let stream of this.incomingStreams.values())
			//Stop it
			stream.stop();
		

		//Remove all emitting streams
		for (let stream of this.outgoingStreams.values())
			//Stop it
			stream.stop();
			
		//IF we hve a transport
		if (this.transport)
			//Stop transport
			this.transport.stop();
		
		//Clean them
		this.room = null;
		this.incomingStreams = null;
		this.outgoingStreams = null;
		this.transport = null;
		this.localSDP = null;
		this.remoteSDP = null;
	
		//Done
		this.debug("onstopped");
		this.emitter.emit("stopped");
	}
};




class Room
{
	constructor(id,ip)
	{
		//Store id
		this.id = id;
		
		//Create UDP server endpoint
		this.endpoint = MediaServer.createEndpoint(ip);
		
		//The comentarist set
		this.participants = new Map();
		
		//Create the room media capabilities
		this.capabilities = {
			audio : {
				codecs		: CodecInfo.MapFromNames(["opus"]),
				extensions	: new Set([
					"urn:ietf:params:rtp-hdrext:ssrc-audio-level",
					"http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01"
				])
			},
			video : {
				codecs		: CodecInfo.MapFromNames(["vp8","flexfec-03"],true),
				extensions	: new Set([
					"http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
					"http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01"
				])
			}
		};
		
		//No participants
		this.max = 0;
		
		//Create event emitter
		this.emitter = new EventEmitter();
		
		//Create uri
		this.uri = ["rooms",id];
		
		this.debug = function(str) {
			console.log("room["+id+"]::"+str);
		};
	}
	
	getId() 
	{
		return this.id;
	}
	
	getEndpoint() 
	{
		return this.endpoint;
	}
	
	getCapabilities() {
		return this.capabilities;
	}
	
	createParticipant(name) 
	{
		this.debug("createParticipant() "+ name);
		
		//Create participant
		const participant = new Participant(
			this.max++,
			name,
			this
		);
	
		participant.on('stream',(stream)=>{
			//Send it to the other participants
			for (let other of this.participants.values())
				//Check it is not the event source
				if (participant.getId()!=other.getId())
					//Add stream to participant
					other.addStream(stream);
		});
		
		//Wait for stopped event
		participant.on('stopped', () => {
			//Delete comentarist
			this.participants.delete(participant.id);
			//emir participant change
			this.emitter.emit("participants",this.participants.values());
		});
		
		//Add to the participant to list
		this.participants.set(participant.id,participant);
		
		//emit participant change
		this.emitter.emit("participants",this.participants.values());
		
		//Done
		return participant;
	}
	
	getStreams() {
		const streams = [];
		
		//For each participant
		for (let participant of this.participants.values())
			//For each stream
			for (let stream of participant.getIncomingStreams())
				//Add participant streams
				streams.push(stream);
		//return them
		return streams;
	}
	
	getInfo() 
	{
		//Create info 
		const info = {
			id : this.id,
			participants : []
		};
		
		//For each participant
		for (let participant of this.participants.values())
			//Append it
			info.participants.push(participant.getInfo());
		
		//Return it
		return info;
	}
	
	/**
	 * Add event listener
	 * @param {String} event	- Event name 
	 * @param {function} listeener	- Event listener
	 * @returns {Transport} 
	 */
	on() 
	{
		//Delegate event listeners to event emitter
		this.emitter.on.apply(this.emitter, arguments);  
		//Return object so it can be chained
		return this;
	}
	
	/**
	 * Remove event listener
	 * @param {String} event	- Event name 
	 * @param {function} listener	- Event listener
	 * @returns {Transport} 
	 */
	off() 
	{
		//Delegate event listeners to event emitter
		this.emitter.removeListener.apply(this.emitter, arguments);
		//Return object so it can be chained
		return this;
	}
	
	stop()
	{
		
	}
};




MediaServer.enableDebug(false);
MediaServer.enableUltraDebug(false);

const rooms = new Map();

const app = express();
const webServer = http.createServer(app);

const wss = new WebSocket.Server({ noServer:true});
const ip = '127.0.0.1';


webServer.on('upgrade', async (req,sock,head) => {

	const pathname = url.parse(req.url).pathname;
    wss.handleUpgrade(req,sock,head, async (socket) => {

        let updateParticipants;
        let participant;
        let room = rooms.get(url.query.id);
        
        //if not found
        if (!room) 
        {
            //Create new Room
            room = new Room(url.query.id,ip);
            //Append to room list
            rooms.set(room.getId(), room);
        }

        const tm = new TransactionManager(sock);

        //Handle incoming commands
        tm.on("cmd", async function(cmd) 
        {
            //Get command data
            const data = cmd.data;
            //check command type
            switch(cmd.name)
            {
                case "join":
                    try {
                        //Check if we already have a participant
                        if (participant)
                            return cmd.reject("Already joined");

                        //Create it
                        participant = room.createParticipant(data.name);
                        
                        //Check
                        if (!participant)
                            return cmd.reject("Error creating participant");

                        //Add listener
                        room.on("participants",(updateParticipants = (participants) => {
                            console.log("room::participants");
                            tm.event("participants", participants);
                        }));
                        
                        //Process the sdp
                        const sdp = SDPInfo.process(data.sdp);
            
                        //Get all streams before adding us
                        const streams = room.getStreams();
                        
                        //Init participant
                        participant.init(sdp);
                        
                        //For each one
                        for (let stream of streams)
                            //Add it
                            participant.addStream(stream);
                        
                        //Get answer
                        const answer = participant.getLocalSDP();

                        //Accept cmd
                        cmd.accept({
                            sdp	: answer.toString(),
                            room	: room.getInfo()
                        });
                        
                        //For all remote streams
                        for (let stream of sdp.getStreams().values())
                            //Publish them
                            participant.publishStream(stream);
                        
                        participant.on("renegotiationneeded",(sdp) => {
                            console.log("participant::renegotiationneeded");
                            //Send update event
                            tm.event('update',{
                                sdp	: sdp.toString()
                            });
                        });
                        
                        //listen for participant events
                        participant.on("closed",function(){
                            //close ws
                            sock.close();
                            //Remove room listeners
                            room.off("participants",updateParticipants);
                        });
                        
                    } catch (error) {
                        console.error(error);
                        //Error
                        cmd.reject({
                            error: error
                        });
                    }
                    break;
            }
        });

        sock.on("close", function(){
            console.log("connection:onclose");
            //Check if we had a participant
            if (participant)
                //remove it
                participant.stop();
        });

    })

})
