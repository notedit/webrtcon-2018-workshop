const express = require('express');

const app = express();

app.use(express.static('./'));

app.listen(4001, function () {
    console.log('Example app listening on port 4001!\n');
    console.log('Open http://localhost:4001/');
})