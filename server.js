 const cors = require('cors');
 const {Server} = require('socket.io');
 const http = require('http');
 const express = require('express');
 const fs = require('fs');
 const app = express();
 const {Readable} = require('stream');
 const axios = require('axios');
 const OpenAI = require('openai')
const {S3Client, PutObjectCommand} = require('@aws-sdk/client-s3')

 const server = http.createServer(app);

 const dotenv = require('dotenv');

 const openai = new OpenAI({
    apiKey: process.env.OPENAI_KEY
 })

 const s3Client = new S3Client({
    region: process.env.BUCKET_REGION,
    credentials: {
        accessKeyId: process.env.ACCESS_KEY,
        secretAccessKey: process.env.SECRET_KEY
    }
 })
 
 dotenv.config();
 app.use(cors());

 const io = new Server(server, {
    cors : {
        origin: process.env.ELECTRON_HOST,
        methods: ['GET','POST']
    }
 })
let recordedChunks = []

// Ensure temp_upload directory exists
if (!fs.existsSync('temp_upload/')) {
    fs.mkdirSync('temp_upload/')
}

 io.on('connection', (socket) => {
    console.log( '🟢 Socket is connected')
  socket.on('video-chunks', async (data) => {
    console.log('🟢 Video chunks are sent', data)

    const filePath = `temp_upload/${data.filename}.webm`
    const writeStream = fs.createWriteStream(filePath)
     recordedChunks.push(data.chunks)
     console.log(filePath)
    
     const videoBlob = new Blob(recordedChunks, {
        type: 'video/webm; codecs=vp9',
     })
     const buffer = Buffer.from(await videoBlob.arrayBuffer())
     const readStream = Readable.from(buffer)
     
     writeStream.on('error', (error) => {
        console.error('Error writing file:', error)
        socket.emit('upload-error', { message: 'Failed to save video file' })
     })

     readStream.pipe(writeStream).on('finish', () => {
        console.log('🟢 Chunk saved')
     })
  })
  socket.on('process-chunks', async (data) => {
    console.log('🟢 Processing video...')
    recordedChunks = [] 
    fs.readFile('temp_upload/'+data.filename, async (err, data) => {
      const processing = await axios.post(`${process.env.NEXT_API_HOST}/${data.userId}/processing`)
      if(processing.data.status !== 200) return console.log('🔴 Error: Something went wrong with creating the processing file')
         const Key = data.filename 
         const Bucket = process.env.BUCKET_NAME 
         const ContentType = 'video/webm' 
         const command = new PutObjectCommand({
            Bucket,
            Key,
            Body: file,
            ContentType
         })
         const fileStatus = await s3Client.send(command)
         if(fileStatus['$metadata'].httpStatusCode === 200){
            console.log("🟢 Video uploaded to AWS successfully!")
             //make it to PRO LATER
            if(processing.data.plan === 'FREE'){
               fs.stat('temp_upload/'+data.filename, async (err, stat) => {
                  if(!err){
                     //wisper
                     if(stat.size < 25000000){
                        const transcription = await openai.audio.transcriptions.create({
                           model: 'whisper-1',
                           file: fs.createReadStream('temp_upload/'+data.filename),
                           response_format: 'text',
                        })
                        if(transcription){
                           const completion = await openai.chat.completions.create({
                              model: 'gpt-3.5-turbo',
                              response_format: {type: 'json_object'},
                              messages : [
                                 {
                                    role : 'system',
                                    content : `You are going to generate a title and a nice description using the speech to text transcription provided: transcription(${transcription}) 
                                    and then return it in json format as {"title":<the title you gave>,"description":<the description you gave>,"summary":<the summary you gave>}`
                                 }
                              ]
                           })
                           const titleAndSummary = await axios.post(`
                              ${process.env.NEXT_API_HOST}/recording/${data.userId}/transcribe`,
                              {
                                filename : data.filename,
                                content : completion.choices[0].message.content,
                                transcript : transcription
                              }
                           )
                           if(titleAndSummary.data.status !== 200) 
                              return console.log('🔴 Error: Something went wrong with creating the title and summary')
                           console.log('🟢 Title and summary created successfully!')
                        }
                     }
                  }
               })
            }
            const stopProcessing = await axios.post(`${process.env.NEXT_API_HOST}/${data.userId}/complete`, {
               filename : data.filename
            })
            if(stopProcessing.data.status !== 200)
             return console.log('🔴 Error: Something went wrong with stopping the processing')
            console.log('🟢 Processing stopped successfully!')

            if(stopProcessing.data.status === 200){
               fs.unlink('temp_upload/'+data.filename, (err) => {
                  if(!err) console.log(data.filename + '' + '🟢 deleted successfully')
               })
            }
         }else{
            console.log('🔴 Error: Something went wrong with uploading the video to AWS')
         }

    })
  })
  socket.on('disconnect', async(data) => {
    console.log('🟢 Socket.id is disconnected', socket.id)  ;
  })
})

 server.listen(5000,() => {
        console.log(' 🟢 Server is running on port 5000');
 })